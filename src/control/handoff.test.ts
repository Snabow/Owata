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

const pcScript: PcDecisionBody[] = [
  { decision: "BUILD", rationale: "start", authorized_finding_ids: [], rework_scope: null, human_gate_purpose: null, human_gate_choices: null },
  { decision: "REWORK", rationale: "apply finding", authorized_finding_ids: ["WP003-TEST-001"], rework_scope: "WP003-TEST-001", human_gate_purpose: null, human_gate_choices: null },
  {
    decision: "HUMAN_GATE",
    rationale: "accept candidate B?",
    authorized_finding_ids: [],
    rework_scope: null,
    human_gate_purpose: "Accept candidate B?",
    human_gate_choices: ["ACCEPT", "ABORT"],
  },
];

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
      policy: { on_builder_candidate: "DISPATCH_REVIEW" },
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
    assert.equal(last.cycle.state, "AWAITING_PC");
    last = dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(last.cycle.state, "AWAITING_PC");
    last = dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(last.cycle.state, "HUMAN_GATE");
    assert.equal(builder.invocations, 2);
    assert.equal(reviewer.invocations, 2);
    assert.equal(pc.invocations, 3);

    const envelopes = handoff.listEnvelopes(cycle.cycle_id);
    const requests = envelopes.filter((e) => e.kind === "control_request");
    const builderResults = envelopes.filter((e) => e.kind === "builder_result");
    const reviewerResults = envelopes.filter((e) => e.kind === "reviewer_result");
    const decisions = envelopes.filter((e) => e.kind === "program_control_decision");

    assert.equal(requests.length, 4); // BUILD, REVIEW A, REWORK, REVIEW B
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
    assert.deepEqual(actions, ["BUILD", "REVIEW", "REWORK", "REVIEW"]);

    assert.equal((builderResults[0].body as { candidate_sha: string }).candidate_sha, "sha-a");
    assert.equal((builderResults[1].body as { candidate_sha: string }).candidate_sha, "sha-b");
    assert.equal(builderResults[0].request_id, requests[0].request_id);
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
      [pcScript[0], { ...pcScript[0], decision: "ACCEPT", rationale: "done", authorized_finding_ids: [], rework_scope: null, human_gate_purpose: null, human_gate_choices: null }],
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
    dispatcher.step(cycle.cycle_id); // BUILD
    dispatcher.step(cycle.cycle_id); // builder
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
      policy: { on_builder_candidate: "DISPATCH_REVIEW" },
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
    dispatcher.step(cycle.cycle_id);
    dispatcher.step(cycle.cycle_id);
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
      policy: { on_builder_candidate: "DISPATCH_REVIEW" },
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
    dispatcher.step(cycle.cycle_id);
    const result = dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "capability_block");
    assert.equal(builder.invocations, 0);
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
      policy: { on_builder_candidate: "DISPATCH_REVIEW" },
    });
    const pc = new FakeProgramControlAdapter([pcScript[0]], envClock);
    const builder = new FakeBuilderAdapter([{ invalid: true }], envClock);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      { owner: "disp-1", leaseMs: 60_000 },
    );
    dispatcher.step(cycle.cycle_id);
    const result = dispatcher.step(cycle.cycle_id);
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
    const pc = new FakeProgramControlAdapter([pcScript[0]], envClock);
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
    dispatcher.step(cycle.cycle_id);
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
        pcScript[0],
        {
          decision: "ABORT",
          rationale: "explicit abort after recovery",
          authorized_finding_ids: [],
          rework_scope: null,
          human_gate_purpose: null,
          human_gate_choices: null,
        },
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
    const pc = new FakeProgramControlAdapter([pcScript[0]], envClock);
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
    assert.equal(handoff2.requireCycle(cycle.cycle_id).current_request_id, requestId);
    const latest = handoff2.latestDispatch(cycle.cycle_id, requestId)!;
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
    const pc = new FakeProgramControlAdapter([pcScript[0]], envClock);
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
    dispatcher.runUntilStable(cycle.cycle_id);
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
