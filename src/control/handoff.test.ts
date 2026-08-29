import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ControlError,
  ControlStore,
  Dispatcher,
  HandoffStore,
  SCHEMA_VERSION,
  dbPath,
} from "./index.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "./fixtures/fake-adapters.js";
import { parseCanonicalEnvelope, PROTOCOL_V1 } from "./protocol.js";
import type { PcDecisionBody } from "./protocol.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const claimDispatchJs = join(
  root,
  "dist",
  "control",
  "fixtures",
  "claim-dispatch-and-hold.js",
);

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-wp003-"));
}

function cleanup(dir: string): string | void {
  for (let i = 0; i < 12; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
}

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function clockBox(start = "2026-06-01T00:00:00.000Z"): {
  now: () => Date;
  advanceMs: (ms: number) => void;
} {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advanceMs: (delta) => {
      ms += delta;
    },
  };
}

function envelopeClock(store: ControlStore) {
  return {
    id: (prefix?: string) => store.nextId(prefix),
    now: () => store.now().toISOString(),
  };
}

function createExactV4Database(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(dbPath(stateDir));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_items (
      work_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      task_type TEXT,
      task_input TEXT,
      repair_count INTEGER NOT NULL DEFAULT 0,
      max_repairs INTEGER NOT NULL DEFAULT 1,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_attempts (
      attempt_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES work_items(work_id),
      attempt_number INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      execution_ok INTEGER,
      result_json TEXT,
      verification_status TEXT,
      verification_detail TEXT,
      attempt_outcome TEXT,
      repair_applied INTEGER NOT NULL DEFAULT 0,
      repair_note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (work_id, attempt_number)
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      event_seq INTEGER,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project_id TEXT,
      work_id TEXT,
      payload TEXT NOT NULL,
      jsonl_flushed INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_events_seq ON events(event_seq);
  `);
  db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 4)").run();
  db.prepare(
    `INSERT INTO projects VALUES ('prj_v4','v4','ACTIVE','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO work_items VALUES (
      'wrk_v4','prj_v4','v4-work','QUEUED',0,NULL,NULL,NULL,'sum_two','{"a":1}',0,1,NULL,
      '2026-01-01T00:00:01.000Z','2026-01-01T00:00:01.000Z'
    )`,
  ).run();
  db.prepare(
    `INSERT INTO events VALUES (
      'evt_v4',1,'2026-01-01T00:00:00.000Z','project.created','prj_v4',NULL,'{"name":"v4"}',1
    )`,
  ).run();
  db.close();
  writeFileSync(
    join(stateDir, "events.jsonl"),
    `${JSON.stringify({
      event_id: "evt_v4",
      event_seq: 1,
      ts: "2026-01-01T00:00:00.000Z",
      event_type: "project.created",
      project_id: "prj_v4",
      work_id: null,
      payload: { name: "v4" },
    })}\n`,
    "utf8",
  );
}

function openHarness(dir: string, clock = clockBox()) {
  const store = ControlStore.open({
    stateDir: dir,
    clock: clock.now,
    idFactory: seqIds(),
  });
  const handoff = new HandoffStore(store);
  const envClock = envelopeClock(store);
  return { store, handoff, clock, envClock };
}

function pcDecision(
  partial: Partial<PcDecisionBody> & Pick<PcDecisionBody, "decision">,
): PcDecisionBody {
  return {
    rationale: null,
    authorized_finding_ids: [],
    rework_scope: null,
    human_gate_purpose: null,
    human_gate_choices: null,
    install_policy: null,
    ...partial,
  };
}

const pcScript: PcDecisionBody[] = [
  pcDecision({
    decision: "BUILD",
    rationale: "start",
    install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
  }),
  pcDecision({
    decision: "REWORK",
    rationale: "apply finding",
    authorized_finding_ids: ["WP003-TEST-001"],
    rework_scope: "WP003-TEST-001",
  }),
  pcDecision({
    decision: "HUMAN_GATE",
    rationale: "accept candidate B?",
    human_gate_purpose: "Accept candidate B?",
    human_gate_choices: ["ACCEPT", "ABORT"],
  }),
];

/** BUILD that leaves review to Program Control (no auto-dispatch). */
const pcBuildAwait: PcDecisionBody = pcDecision({
  decision: "BUILD",
  rationale: "start",
  install_policy: { on_builder_candidate: "AWAIT_PC" },
});

test("fresh database initializes at schema v5", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    assert.equal(store.schemaVersion(), 5);
    assert.equal(SCHEMA_VERSION, 5);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("real v4 state migrates to v5 without losing rows", () => {
  const dir = tempState();
  try {
    createExactV4Database(dir);
    const store = ControlStore.open({ stateDir: dir });
    assert.equal(store.schemaVersion(), 5);
    assert.equal(store.getProject("prj_v4")?.name, "v4");
    assert.equal(store.getWork("wrk_v4")?.title, "v4-work");
    assert.equal(store.getWork("wrk_v4")?.task_type, "sum_two");
    const events = store.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].event_id, "evt_v4");
    assert.equal(events[0].event_seq, 1);
    const jsonl = store.readJsonlEvents();
    assert.equal(jsonl[0].event_id, "evt_v4");
    store.close();
    const again = ControlStore.open({ stateDir: dir });
    assert.equal(again.schemaVersion(), 5);
    assert.equal(again.getWork("wrk_v4")?.title, "v4-work");
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("WP003 Slice 1: full fake REWORK cycle with Human Gate", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("wp003");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base-sha-0",
    });
    const pc = new FakeProgramControlAdapter(pcScript, envClock);
    const builder = new FakeBuilderAdapter(
      [
        { status: "CANDIDATE_READY", candidate_sha: "sha-a" },
        { status: "CANDIDATE_READY", candidate_sha: "sha-b" },
      ],
      envClock,
    );
    const reviewer = new FakeReviewerAdapter(
      [
        {
          verdict: "REWORK",
          findings: [
            { finding_id: "WP003-TEST-001", severity: "HIGH", summary: "fix A" },
          ],
        },
        { verdict: "PASS" },
      ],
      envClock,
    );
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      { owner: "disp-1", leaseMs: 60_000 },
    );

    let last = dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(last.cycle.state, "HUMAN_GATE");
    assert.equal(builder.invocations, 2);
    assert.equal(reviewer.invocations, 2);
    assert.equal(pc.invocations, 3);
    assert.ok(pc.preflightCount >= 3);
    assert.ok(handoff.requireCycle(cycle.cycle_id).policy_authorized_by_decision_id);

    const envelopes = handoff.listEnvelopes(cycle.cycle_id);
    const requests = envelopes.filter((e) => e.kind === "control_request");
    const builderResults = envelopes.filter((e) => e.kind === "builder_result");
    const reviewerResults = envelopes.filter((e) => e.kind === "reviewer_result");
    const decisions = envelopes.filter((e) => e.kind === "program_control_decision");

    assert.equal(requests.length, 7); // DECIDE, BUILD, REVIEW, DECIDE, REWORK, REVIEW, DECIDE
    assert.equal(builderResults.length, 2);
    assert.equal(reviewerResults.length, 2);
    assert.equal(decisions.length, 3);

    const reworkReq = requests.find((e) => {
      const b = e.body as { action: string };
      return b.action === "REWORK";
    })!;
    const reworkBody = reworkReq.body as {
      authorized_finding_ids: string[];
      authorized_by_decision_id: string;
    };
    assert.deepEqual(reworkBody.authorized_finding_ids, ["WP003-TEST-001"]);
    const reworkDecision = decisions.find(
      (d) => (d.body as PcDecisionBody).decision === "REWORK",
    )!;
    assert.equal(reworkBody.authorized_by_decision_id, reworkDecision.envelope_id);

    const reviewAfterRework = requests.filter((e) => {
      const b = e.body as { action: string; target_sha: string | null };
      return b.action === "REVIEW";
    });
    assert.equal((reviewAfterRework[0].body as { target_sha: string | null }).target_sha, "sha-a");
    assert.equal((reviewAfterRework[1].body as { target_sha: string | null }).target_sha, "sha-b");

    const firstReview = reviewerResults[0].body as { verdict: string; findings: Array<{ finding_id: string }> };
    assert.equal(firstReview.verdict, "REWORK");
    assert.equal(firstReview.findings[0].finding_id, "WP003-TEST-001");

    // Dispatcher must not have created a REWORK request until PC adjudicated.
    const types = store.listEvents().map((e) => e.event_type);
    const requestEvents = store
      .listEvents()
      .filter((e) => e.event_type === "cycle.request_persisted");
    const actions = requestEvents.map((e) => String(e.payload.action));
    assert.deepEqual(actions, [
      "DECIDE",
      "BUILD",
      "REVIEW",
      "DECIDE",
      "REWORK",
      "REVIEW",
      "DECIDE",
    ]);

    assert.equal((builderResults[0].body as { candidate_sha: string }).candidate_sha, "sha-a");
    assert.equal((builderResults[1].body as { candidate_sha: string }).candidate_sha, "sha-b");
    const buildReq = requests.find((e) => (e.body as { action: string }).action === "BUILD")!;
    assert.equal(builderResults[0].request_id, buildReq.request_id);
    assert.equal(reviewerResults[0].request_id, reviewAfterRework[0].request_id);
    assert.equal(reviewerResults[1].request_id, reviewAfterRework[1].request_id);

    const gate = handoff.openGateForCycle(cycle.cycle_id);
    assert.ok(gate);
    handoff.answerHumanGate({ gateId: gate.gate_id, selectedChoice: "ACCEPT", note: "ok" });
    last = dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(last.cycle.state, "ACCEPTED");
    assert.equal(last.cycle.accepted_candidate_sha, "sha-b");
    assert.equal(last.cycle.latest_candidate_sha, "sha-b");

    store.close();
    const again = ControlStore.open({ stateDir: dir });
    const handoff2 = new HandoffStore(again);
    const restored = handoff2.requireCycle(cycle.cycle_id);
    assert.equal(restored.state, "ACCEPTED");
    assert.equal(restored.accepted_candidate_sha, "sha-b");
    const restoredEnvs = handoff2.listEnvelopes(cycle.cycle_id);
    assert.equal(restoredEnvs.length, envelopes.length + 1);
    const seqs = again.listEvents().map((e) => e.event_seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
    const jsonl = again.readJsonlEvents();
    assert.deepEqual(
      jsonl.map((e) => [String(e.event_id), Number(e.event_seq)]),
      again.listEvents().map((e) => [e.event_id, e.event_seq]),
    );
    assert.ok(types.includes("cycle.created"));
    assert.ok(again.listEvents().some((e) => e.event_type === "cycle.human_gate_answered"));
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("duplicate envelope and replay do not re-invoke after acceptance", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("replay");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
    });
    const pc = new FakeProgramControlAdapter(
      [pcBuildAwait, pcDecision({ decision: "ACCEPT", rationale: "done" })],
      envClock,
    );
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-a" }],
      envClock,
    );
    const reviewer = new FakeReviewerAdapter([], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      { owner: "disp-1", leaseMs: 60_000 },
    );
    dispatcher.step(cycle.cycle_id); // PC → DISPATCHING_BUILD
    dispatcher.step(cycle.cycle_id); // builder → AWAITING_PC
    assert.equal(builder.invocations, 1);
    const accepted = handoff.listEnvelopes(cycle.cycle_id).find((e) => e.kind === "builder_result")!;
    const again = handoff.persistEnvelope(accepted);
    assert.equal(again.envelope_id, accepted.envelope_id);
    assert.throws(
      () =>
        handoff.claimDispatch({
          cycleId: cycle.cycle_id,
          requestId: accepted.request_id!,
          targetRole: "builder",
          owner: "disp-1",
          leaseMs: 1000,
        }),
      (err: unknown) => err instanceof ControlError && err.code === "ALREADY_ACCEPTED",
    );
    dispatcher.step(cycle.cycle_id); // already accepted / AWAITING_PC
    assert.equal(builder.invocations, 1);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("stale reviewer SHA is RESULT_STALE and does not advance", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("stale-sha");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
    });
    const pc = new FakeProgramControlAdapter([pcScript[0]], envClock);
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-b" }],
      envClock,
    );
    const reviewer = new FakeReviewerAdapter(
      [{ verdict: "PASS", target_sha: "sha-a" }],
      envClock,
    );
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      { owner: "disp-1", leaseMs: 60_000 },
    );
    dispatcher.step(cycle.cycle_id); // PC BUILD + policy install
    dispatcher.step(cycle.cycle_id); // builder → DISPATCHING_REVIEW
    const before = handoff.requireCycle(cycle.cycle_id);
    assert.equal(before.state, "DISPATCHING_REVIEW");
    const result = dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "result_stale");
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "DISPATCHING_REVIEW");
    const rejected = store
      .listEvents()
      .filter((e) => e.event_type === "cycle.result_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].payload.failure_class, "RESULT_STALE");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("capability preflight blocks before invocation", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("cap");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
    });
    const pc = new FakeProgramControlAdapter([pcScript[0]], envClock);
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-a" }],
      envClock,
      ["repository_read"],
    );
    const reviewer = new FakeReviewerAdapter([], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      { owner: "disp-1", leaseMs: 60_000 },
    );
    dispatcher.step(cycle.cycle_id); // PC
    const result = dispatcher.step(cycle.cycle_id); // builder capability
    assert.equal(result.action, "capability_block");
    assert.equal(builder.invocations, 0);
    assert.ok(pc.invocations >= 1);
    assert.ok(pc.preflightCount >= 1);
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "RECOVERY_REQUIRED");
    assert.equal(handoff.requireCycle(cycle.cycle_id).recovery_reason, "CAPABILITY_BLOCK");
    assert.ok(
      store.listEvents().some((e) => e.event_type === "cycle.capability_blocked"),
    );
    assert.equal(
      handoff.listEnvelopes(cycle.cycle_id).filter((e) => e.kind === "builder_result").length,
      0,
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("invalid adapter result is RESULT_INVALID", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("invalid");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
    });
    const pc = new FakeProgramControlAdapter([pcScript[0]], envClock);
    const builder = new FakeBuilderAdapter([{ invalid: true }], envClock);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      { owner: "disp-1", leaseMs: 60_000 },
    );
    dispatcher.step(cycle.cycle_id); // PC
    const result = dispatcher.step(cycle.cycle_id); // invalid builder
    assert.equal(result.action, "result_invalid");
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "DISPATCHING_BUILD");
    const rejected = store
      .listEvents()
      .find((e) => e.event_type === "cycle.result_rejected");
    assert.equal(rejected?.payload.failure_class, "RESULT_INVALID");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("stale fence cannot overwrite the accepted result", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock, clock } = openHarness(dir);
    const project = store.createProject("fence");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
    });
    const pc = new FakeProgramControlAdapter([pcBuildAwait], envClock);
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-new" }],
      envClock,
    );
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder,
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "disp-1", leaseMs: 1000 },
    );
    dispatcher.step(cycle.cycle_id); // PC → DISPATCHING_BUILD
    const first = dispatcher.claimCurrent(cycle.cycle_id);
    clock.advanceMs(2000);
    handoff.recoverExpiredDispatches(store.now());
    const second = dispatcher.claimCurrent(cycle.cycle_id);
    assert.equal(second.attempt_number, 2);
    assert.notEqual(second.fence_token, first.fence_token);
    const staleEnv = parseCanonicalEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: store.nextId("env"),
      kind: "builder_result",
      cycle_id: cycle.cycle_id,
      request_id: first.request_id,
      from_role: "builder",
      to_role: "program_control",
      created_at: store.now().toISOString(),
      body: {
        status: "CANDIDATE_READY",
        candidate_sha: "sha-stale",
        evidence_refs: [],
        notes: null,
      },
    });
    assert.throws(
      () =>
        handoff.acceptResult({
          dispatchId: first.dispatch_id,
          fenceToken: first.fence_token,
          envelope: staleEnv,
        }),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    dispatcher.step(cycle.cycle_id);
    assert.equal(handoff.requireCycle(cycle.cycle_id).latest_candidate_sha, "sha-new");
    assert.notEqual(handoff.requireCycle(cycle.cycle_id).latest_candidate_sha, "sha-stale");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("retry budget exhaustion returns to Program Control, not ABORT", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock, clock } = openHarness(dir);
    const project = store.createProject("budget");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
      maxDispatchRetries: 1,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcBuildAwait,
        pcDecision({
          decision: "ABORT",
          rationale: "explicit abort after recovery",
        }),
      ],
      envClock,
    );
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-a" }],
      envClock,
    );
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder,
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "disp-1", leaseMs: 500 },
    );
    dispatcher.step(cycle.cycle_id);
    dispatcher.claimCurrent(cycle.cycle_id);
    clock.advanceMs(1000);
    handoff.recoverExpiredDispatches(store.now());
    const result = dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "retry_budget");
    const recovered = handoff.requireCycle(cycle.cycle_id);
    assert.equal(recovered.state, "RECOVERY_REQUIRED");
    assert.equal(recovered.recovery_reason, "dispatch_retry_budget_exhausted");
    assert.notEqual(recovered.state, "ABORTED");
    assert.ok(
      store.listEvents().some((e) => e.event_type === "cycle.recovery_required"),
    );
    const afterPc = dispatcher.step(cycle.cycle_id);
    assert.equal(afterPc.cycle.state, "ABORTED");
    assert.equal(pc.invocations, 2);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("protocol rejects credential-like fields", () => {
  assert.throws(
    () =>
      parseCanonicalEnvelope({
        protocol: PROTOCOL_V1,
        envelope_id: "e1",
        kind: "builder_result",
        cycle_id: "c1",
        request_id: "r1",
        from_role: "builder",
        to_role: "program_control",
        created_at: "2026-01-01T00:00:00.000Z",
        api_key: "secret",
        body: {
          status: "CANDIDATE_READY",
          candidate_sha: "x",
          evidence_refs: [],
          notes: null,
        },
      }),
    (err: unknown) => err instanceof ControlError && err.code === "RESULT_INVALID",
  );
});

test("process interruption recovers same request_id under a new fence", async () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const handoff = new HandoffStore(store);
    const envClock = envelopeClock(store);
    const project = store.createProject("crash");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
      maxDispatchRetries: 3,
    });
    const pc = new FakeProgramControlAdapter([pcBuildAwait], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder: new FakeBuilderAdapter([], envClock),
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "parent", leaseMs: 400 },
    );
    dispatcher.step(cycle.cycle_id);
    const requestId = handoff.requireCycle(cycle.cycle_id).current_request_id!;
    store.close();

    const child = spawn(
      process.execPath,
      [claimDispatchJs, dir, cycle.cycle_id, "child-owner", "400"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
    });
    const claimed = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no claim: ${out}`)), 8000);
      child.stdout.on("data", () => {
        if (out.includes("HOLDING")) {
          clearTimeout(t);
          resolve(out);
        }
      });
    });
    const announced = await claimed;
    assert.match(announced, new RegExp(`CLAIMED ${requestId} `));
    const oldFence = announced.trim().split(/\s+/)[2];
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => setTimeout(r, 600));

    const resume = ControlStore.open({ stateDir: dir });
    const handoff2 = new HandoffStore(resume);
    handoff2.recoverExpiredDispatches(resume.now());
    const env2 = envelopeClock(resume);
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-resume" }],
      env2,
    );
    const dispatcher2 = new Dispatcher(
      handoff2,
      {
        programControl: new FakeProgramControlAdapter([], env2),
        builder,
        reviewer: new FakeReviewerAdapter([], env2),
      },
      { owner: "resume-owner", leaseMs: 10_000 },
    );
    const after = dispatcher2.step(cycle.cycle_id);
    assert.equal(after.action, "builder_result");
    assert.equal(handoff2.requireCycle(cycle.cycle_id).latest_candidate_sha, "sha-resume");
    assert.equal(handoff2.requireCycle(cycle.cycle_id).state, "AWAITING_PC");
    assert.equal(handoff2.requireCycle(cycle.cycle_id).current_request_id, null);
    const latest = handoff2.latestDispatch(cycle.cycle_id, requestId)!;
    assert.equal(latest.state, "ACCEPTED");
    assert.equal(latest.attempt_number, 2);
    assert.notEqual(latest.fence_token, oldFence);
    const staleEnv = parseCanonicalEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: resume.nextId("env"),
      kind: "builder_result",
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      from_role: "builder",
      to_role: "program_control",
      created_at: resume.now().toISOString(),
      body: {
        status: "CANDIDATE_READY",
        candidate_sha: "sha-from-dead-child",
        evidence_refs: [],
        notes: null,
      },
    });
    const expired = resume.db
      .prepare(
        `SELECT dispatch_id, fence_token FROM dispatches
         WHERE request_id = ? AND attempt_number = 1`,
      )
      .get(requestId) as { dispatch_id: string; fence_token: string };
    assert.throws(
      () =>
        handoff2.acceptResult({
          dispatchId: expired.dispatch_id,
          fenceToken: expired.fence_token,
          envelope: staleEnv,
        }),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    assert.equal(handoff2.requireCycle(cycle.cycle_id).latest_candidate_sha, "sha-resume");
    resume.close();
  } finally {
    cleanup(dir);
  }
});

test("forbidden secret fields never appear in persisted envelopes", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("sec");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      policy: { on_builder_candidate: "AWAIT_PC" },
    });
    const pc = new FakeProgramControlAdapter([pcBuildAwait], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder: new FakeBuilderAdapter(
          [{ status: "CANDIDATE_READY", candidate_sha: "sha-a" }],
          envClock,
        ),
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "d", leaseMs: 1000 },
    );
    dispatcher.step(cycle.cycle_id); // PC BUILD
    dispatcher.step(cycle.cycle_id); // builder → AWAITING_PC
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "AWAITING_PC");
    const text = JSON.stringify(handoff.listEnvelopes(cycle.cycle_id));
    assert.equal(/api_key|password|oauth_token|private_key/i.test(text), false);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("unknown future schema still rejected", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    store.close();
    const db = new DatabaseSync(dbPath(dir));
    db.prepare("UPDATE schema_meta SET version = 99 WHERE id = 1").run();
    db.close();
    assert.throws(
      () => ControlStore.open({ stateDir: dir }),
      /Unsupported schema version 99/,
    );
  } finally {
    cleanup(dir);
  }
});

test("R1: createCycle rejects unproven DISPATCH_REVIEW policy", () => {
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    const project = store.createProject("pol");
    assert.throws(
      () =>
        handoff.createCycle({
          projectId: project.project_id,
          workPackageRef: "WP-003",
          policy: { on_builder_candidate: "DISPATCH_REVIEW" },
        }),
      (err: unknown) => err instanceof ControlError && err.code === "POLICY_PROVENANCE",
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: incapable Program Control is preflight-blocked", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("pc-cap");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const pc = new FakeProgramControlAdapter([pcBuildAwait], envClock, []);
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder: new FakeBuilderAdapter([], envClock),
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "d", leaseMs: 1000 },
    );
    const result = dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "capability_block");
    assert.equal(pc.preflightCount, 1);
    assert.equal(pc.invocations, 0);
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "RECOVERY_REQUIRED");
    assert.equal(
      handoff.listEnvelopes(cycle.cycle_id).filter((e) => e.kind === "program_control_decision")
        .length,
      0,
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: competing PC decisions ? stale cannot override ABORT", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("pc-race");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const d1 = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "ABORT", rationale: "stop" })],
          envClock,
        ),
        builder: new FakeBuilderAdapter([], envClock),
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "owner-a", leaseMs: 60_000 },
    );
    const first = d1.step(cycle.cycle_id);
    assert.equal(first.cycle.state, "ABORTED");
    const pcReq = handoff
      .listEnvelopes(cycle.cycle_id)
      .find((e) => e.kind === "control_request")!;
    const accepted = handoff.acceptedDispatch(cycle.cycle_id, pcReq.request_id!)!;
    const staleBuild = parseCanonicalEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: store.nextId("env"),
      kind: "program_control_decision",
      cycle_id: cycle.cycle_id,
      request_id: pcReq.request_id,
      from_role: "program_control",
      to_role: "dispatcher",
      created_at: store.now().toISOString(),
      body: pcDecision({ decision: "BUILD", rationale: "stale" }),
    });
    assert.throws(
      () =>
        handoff.acceptResult({
          dispatchId: accepted.dispatch_id,
          fenceToken: accepted.fence_token,
          envelope: staleBuild,
        }),
      (err: unknown) =>
        err instanceof ControlError &&
        (err.code === "STALE_FENCE" || err.code === "ALREADY_ACCEPTED"),
    );
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "ABORTED");
    assert.equal(
      handoff.listEnvelopes(cycle.cycle_id).filter((e) => e.kind === "program_control_decision")
        .length,
      1,
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: miswired Builder cannot self-approve via PC Decision envelope", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("evil-builder");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "ignored" }],
      envClock,
    );
    builder.maliciousRaw = {
      protocol: PROTOCOL_V1,
      envelope_id: "evil_accept",
      kind: "program_control_decision",
      cycle_id: cycle.cycle_id,
      request_id: "placeholder",
      from_role: "program_control",
      to_role: "dispatcher",
      created_at: "2026-06-01T00:00:00.000Z",
      body: pcDecision({ decision: "ACCEPT", rationale: "self-approve" }),
    };
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD", rationale: "go" })],
          envClock,
        ),
        builder,
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "d", leaseMs: 5000 },
    );
    dispatcher.step(cycle.cycle_id);
    const buildReq = handoff.requireCycle(cycle.cycle_id).current_request_id!;
    (builder.maliciousRaw as { request_id: string }).request_id = buildReq;
    (builder.maliciousRaw as { cycle_id: string }).cycle_id = cycle.cycle_id;
    const result = dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "result_invalid");
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "DISPATCHING_BUILD");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: miswired PC adapter identity cannot obtain PC authority", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("bad-pc-id");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const pc = new FakeProgramControlAdapter(
      [pcDecision({ decision: "ACCEPT" })],
      envClock,
      ["repository_read"],
      "builder",
    );
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder: new FakeBuilderAdapter([], envClock),
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "d", leaseMs: 1000 },
    );
    const result = dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "adapter_role_mismatch");
    assert.equal(pc.invocations, 0);
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "RECOVERY_REQUIRED");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: envelope_id replay with different cycle_id is rejected", () => {
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    const p1 = store.createProject("c1");
    const p2 = store.createProject("c2");
    const c1 = handoff.createCycle({ projectId: p1.project_id, workPackageRef: "WP-003" });
    const c2 = handoff.createCycle({ projectId: p2.project_id, workPackageRef: "WP-003" });
    const env = {
      protocol: PROTOCOL_V1,
      envelope_id: "shared_env_id",
      kind: "builder_result" as const,
      cycle_id: c1.cycle_id,
      request_id: "req_a",
      from_role: "builder" as const,
      to_role: "program_control" as const,
      created_at: "2026-06-01T00:00:00.000Z",
      body: {
        status: "CANDIDATE_READY" as const,
        candidate_sha: "sha-a",
        evidence_refs: [] as string[],
        notes: null as string | null,
      },
    };
    handoff.persistEnvelope(env);
    assert.throws(
      () =>
        handoff.persistEnvelope({
          ...env,
          cycle_id: c2.cycle_id,
          request_id: "req_b",
        }),
      (err: unknown) => err instanceof ControlError && err.code === "DUPLICATE_ENVELOPE",
    );
    assert.equal(handoff.listEnvelopes(c2.cycle_id).length, 0);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: exact duplicate canonical envelope is idempotent", () => {
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    const project = store.createProject("dup");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const env = {
      protocol: PROTOCOL_V1,
      envelope_id: "exact_dup",
      kind: "builder_result" as const,
      cycle_id: cycle.cycle_id,
      request_id: "req_x",
      from_role: "builder" as const,
      to_role: "program_control" as const,
      created_at: "2026-06-01T00:00:00.000Z",
      body: {
        status: "CANDIDATE_READY" as const,
        candidate_sha: "sha-x",
        evidence_refs: [] as string[],
        notes: null as string | null,
      },
    };
    const a = handoff.persistEnvelope(env);
    const b = handoff.persistEnvelope(env);
    assert.equal(a.envelope_id, b.envelope_id);
    assert.equal(handoff.listEnvelopes(cycle.cycle_id).length, 1);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: auto-review without PC provenance does not dispatch Reviewer", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("no-prov");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const reviewer = new FakeReviewerAdapter([{ verdict: "PASS" }], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD", rationale: "no install" })],
          envClock,
        ),
        builder: new FakeBuilderAdapter(
          [{ status: "CANDIDATE_READY", candidate_sha: "sha-a" }],
          envClock,
        ),
        reviewer,
      },
      { owner: "d", leaseMs: 5000 },
    );
    dispatcher.step(cycle.cycle_id); // PC BUILD without install_policy
    const last = dispatcher.step(cycle.cycle_id); // builder → AWAITING_PC (no auto-review)
    assert.equal(last.cycle.state, "AWAITING_PC");
    assert.equal(reviewer.invocations, 0);
    assert.equal(handoff.requireCycle(cycle.cycle_id).latest_candidate_sha, "sha-a");
    assert.equal(handoff.requireCycle(cycle.cycle_id).policy_authorized_by_decision_id, null);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: auto-review with durable PC provenance dispatches Reviewer and survives reopen", () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("prov");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const reviewer = new FakeReviewerAdapter([{ verdict: "PASS" }], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [
            pcDecision({
              decision: "BUILD",
              install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
            }),
          ],
          envClock,
        ),
        builder: new FakeBuilderAdapter(
          [{ status: "CANDIDATE_READY", candidate_sha: "sha-a" }],
          envClock,
        ),
        reviewer,
      },
      { owner: "d", leaseMs: 5000 },
    );
    dispatcher.step(cycle.cycle_id);
    dispatcher.step(cycle.cycle_id);
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "DISPATCHING_REVIEW");
    assert.equal(reviewer.invocations, 0);
    const authId = handoff.requireCycle(cycle.cycle_id).policy_authorized_by_decision_id;
    assert.ok(authId);
    store.close();

    const again = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff2 = new HandoffStore(again);
    const restored = handoff2.requireCycle(cycle.cycle_id);
    assert.equal(restored.policy.on_builder_candidate, "DISPATCH_REVIEW");
    assert.equal(restored.policy_authorized_by_decision_id, authId);
    assert.equal(handoff2.mayAutoDispatchReview(restored), true);
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("R1: Program Control process interruption recovers same request_id", async () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const handoff = new HandoffStore(store);
    const envClock = envelopeClock(store);
    const project = store.createProject("pc-crash");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      maxDispatchRetries: 3,
    });
    const throwing = new FakeProgramControlAdapter(
      [pcDecision({ decision: "BUILD" })],
      envClock,
    );
    throwing.decide = () => {
      throwing.invocations += 1;
      throw new Error("killed-before-result");
    };
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: throwing,
        builder: new FakeBuilderAdapter([], envClock),
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      { owner: "parent", leaseMs: 400 },
    );
    const mid = dispatcher.step(cycle.cycle_id);
    assert.equal(mid.action, "runtime_error");
    const requestId = handoff.requireCycle(cycle.cycle_id).current_request_id!;
    assert.ok(requestId);
    store.close();

    const child = spawn(
      process.execPath,
      [claimDispatchJs, dir, cycle.cycle_id, "child-pc", "400"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
    });
    const claimed = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no claim: ${out}`)), 8000);
      child.stdout.on("data", () => {
        if (out.includes("HOLDING")) {
          clearTimeout(t);
          resolve(out);
        }
      });
    });
    assert.match(claimed, new RegExp(`CLAIMED ${requestId} `));
    const oldFence = claimed.trim().split(/\s+/)[2];
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => setTimeout(r, 600));

    const resume = ControlStore.open({ stateDir: dir });
    const handoff2 = new HandoffStore(resume);
    handoff2.recoverExpiredDispatches(resume.now());
    const env2 = envelopeClock(resume);
    const pc = new FakeProgramControlAdapter(
      [pcDecision({ decision: "BUILD", install_policy: { on_builder_candidate: "AWAIT_PC" } })],
      env2,
    );
    const dispatcher2 = new Dispatcher(
      handoff2,
      {
        programControl: pc,
        builder: new FakeBuilderAdapter([], env2),
        reviewer: new FakeReviewerAdapter([], env2),
      },
      { owner: "resume-pc", leaseMs: 10_000 },
    );
    const after = dispatcher2.step(cycle.cycle_id);
    assert.equal(after.action, "pc_decision");
    assert.equal(handoff2.requireCycle(cycle.cycle_id).state, "DISPATCHING_BUILD");
    const staleDecision = parseCanonicalEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: resume.nextId("env"),
      kind: "program_control_decision",
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      from_role: "program_control",
      to_role: "dispatcher",
      created_at: resume.now().toISOString(),
      body: pcDecision({ decision: "ABORT" }),
    });
    const expired = resume.db
      .prepare(
        `SELECT dispatch_id, fence_token FROM dispatches
         WHERE request_id = ? AND attempt_number = 1`,
      )
      .get(requestId) as { dispatch_id: string; fence_token: string };
    assert.throws(
      () =>
        handoff2.acceptResult({
          dispatchId: expired.dispatch_id,
          fenceToken: expired.fence_token,
          envelope: staleDecision,
        }),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    assert.notEqual(handoff2.requireCycle(cycle.cycle_id).state, "ABORTED");
    assert.ok(oldFence);
    resume.close();
  } finally {
    cleanup(dir);
  }
});
