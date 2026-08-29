import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlStore,
  Dispatcher,
  HandoffStore,
} from "../control/index.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "../control/fixtures/fake-adapters.js";
import type { PcDecisionBody } from "../control/protocol.js";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-git-gate-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
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
    install_policy: { on_builder_candidate: "AWAIT_PC" },
    ...partial,
  };
}

test("non-fake builder without gitReality cannot accept CANDIDATE_READY", async () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "deadbeef" }],
      clock,
    );
    builder.identity = { adapter_id: "test-real-builder", role: "builder" };

    const project = store.createProject("git-gate");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base",
    });
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD" })],
          clock,
        ),
        builder,
        reviewer: new FakeReviewerAdapter([], clock),
      },
      { owner: "test", leaseMs: 60_000 },
    );

    await dispatcher.step(cycle.cycle_id); // PC → DISPATCHING_BUILD
    const result = await dispatcher.step(cycle.cycle_id); // builder
    assert.equal(result.action, "result_invalid");
    const live = handoff.requireCycle(cycle.cycle_id);
    assert.equal(live.latest_candidate_sha, null);
    const dispatch = handoff.latestDispatch(cycle.cycle_id, live.current_request_id ?? "")
      ?? handoff
        .listEnvelopes(cycle.cycle_id)
        .filter((e) => e.kind === "control_request")
        .map((e) => handoff.latestDispatch(cycle.cycle_id, e.request_id!))
        .find(Boolean);
    // After reject, request may still be current or cleared depending on path.
    // Candidate must not be set; no review request for deadbeef.
    assert.ok(
      !handoff
        .listEnvelopes(cycle.cycle_id)
        .some(
          (e) =>
            e.kind === "control_request" &&
            e.body &&
            typeof e.body === "object" &&
            "action" in e.body &&
            (e.body as { action: string }).action === "REVIEW",
        ),
    );
    void dispatch;
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("non-fake builder with failing gitReality rejects candidate", async () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "deadbeef" }],
      clock,
    );
    builder.identity = { adapter_id: "test-real-builder", role: "builder" };

    const project = store.createProject("git-gate-fail");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base",
    });
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD" })],
          clock,
        ),
        builder,
        reviewer: new FakeReviewerAdapter([], clock),
      },
      {
        owner: "test",
        leaseMs: 60_000,
        gitReality: async () => {
          throw new Error("dirty worktree");
        },
      },
    );

    await dispatcher.step(cycle.cycle_id);
    const result = await dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "result_invalid");
    assert.equal(handoff.requireCycle(cycle.cycle_id).latest_candidate_sha, null);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("non-fake builder with passing gitReality accepts candidate", async () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "cafebabe" }],
      clock,
    );
    builder.identity = { adapter_id: "test-real-builder", role: "builder" };
    let verified = false;

    const project = store.createProject("git-gate-ok");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base",
    });
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD" })],
          clock,
        ),
        builder,
        reviewer: new FakeReviewerAdapter([], clock),
      },
      {
        owner: "test",
        leaseMs: 60_000,
        gitReality: async () => {
          verified = true;
        },
      },
    );

    await dispatcher.step(cycle.cycle_id);
    const result = await dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "builder_result");
    assert.equal(verified, true);
    assert.equal(
      handoff.requireCycle(cycle.cycle_id).latest_candidate_sha,
      "cafebabe",
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("fake-builder still accepts without gitReality", async () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };
    const project = store.createProject("git-gate-fake");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base",
    });
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD" })],
          clock,
        ),
        builder: new FakeBuilderAdapter(
          [{ status: "CANDIDATE_READY", candidate_sha: "ffff" }],
          clock,
        ),
        reviewer: new FakeReviewerAdapter([], clock),
      },
      { owner: "test", leaseMs: 60_000 },
    );
    await dispatcher.step(cycle.cycle_id);
    const result = await dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "builder_result");
    assert.equal(handoff.requireCycle(cycle.cycle_id).latest_candidate_sha, "ffff");
    store.close();
  } finally {
    cleanup(dir);
  }
});
