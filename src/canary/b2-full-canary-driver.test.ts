import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlStore,
  Dispatcher,
  HandoffStore,
  PROTOCOL_V1,
} from "../control/index.js";
import type {
  BuilderAdapter,
  ProgramControlAdapter,
  ReviewerAdapter,
} from "../control/adapters.js";
import type {
  CanonicalEnvelope,
  ControlRequestBody,
  PcDecisionBody,
} from "../control/protocol.js";
import {
  B2_S2_CANARY_EXTERNAL_RESULT_REJECTED,
  B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION,
  B2_S2_CANARY_STOP_CONDITION,
  B2_S2_CANARY_WP_REF,
  assertInitialCanaryBuildPolicy,
  initialPcControlRequest,
  seedB2S2InitialPcControlRequest,
} from "./b2-full-canary-contract.js";
import { runB2FullCanaryDriver } from "./b2-full-canary-driver.js";

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function fakePc(
  decisions: PcDecisionBody[],
): ProgramControlAdapter {
  let i = 0;
  return {
    identity: { adapter_id: "fake-pc", role: "program_control" },
    capabilities: () => ["repository_read"],
    preflight: () => ({ ok: true, missing: [] }),
    async decide(input) {
      const body = decisions[Math.min(i, decisions.length - 1)]!;
      i += 1;
      const env: CanonicalEnvelope<PcDecisionBody> = {
        protocol: PROTOCOL_V1,
        envelope_id: `env_pc_${i}`,
        kind: "program_control_decision",
        cycle_id: input.cycle.cycle_id,
        request_id: input.request?.request_id ?? null,
        from_role: "program_control",
        to_role: "dispatcher",
        created_at: new Date().toISOString(),
        body,
      };
      return env;
    },
  };
}

function fakeBuilderReject(): BuilderAdapter {
  return {
    identity: { adapter_id: "fake-builder", role: "builder" },
    capabilities: () => [
      "repository_read",
      "repository_write",
      "exact_checkout",
      "command_execution",
    ],
    preflight: () => ({ ok: true, missing: [] }),
    async build() {
      throw new Error("synthetic builder failure for fail-fast");
    },
  };
}

function fakeReviewerIdle(): ReviewerAdapter {
  return {
    identity: { adapter_id: "fake-reviewer", role: "reviewer" },
    capabilities: () => [
      "repository_read",
      "exact_checkout",
      "command_execution",
    ],
    preflight: () => ({ ok: true, missing: [] }),
    async review() {
      throw new Error("reviewer should not run in this test");
    },
  };
}

test("assertInitialCanaryBuildPolicy rejects AWAIT_PC", () => {
  assert.throws(
    () =>
      assertInitialCanaryBuildPolicy({
        decision: "BUILD",
        rationale: null,
        authorized_finding_ids: [],
        rework_scope: null,
        human_gate_purpose: null,
        human_gate_choices: null,
        install_policy: { on_builder_candidate: "AWAIT_PC" },
      }),
    (err: unknown) =>
      err instanceof Error &&
      String((err as { code?: string }).code) ===
        B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION,
  );
});

test("seedB2S2InitialPcControlRequest writes durable DISPATCH_REVIEW contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-b2s2-seed-"));
  try {
    const store = ControlStore.open({
      stateDir: dir,
      idFactory: seqIds(),
    });
    const handoff = new HandoffStore(store);
    const project = store.createProject("seed-test");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: B2_S2_CANARY_WP_REF,
      baseSha: "a".repeat(40),
      maxDispatchRetries: 1,
    });
    seedB2S2InitialPcControlRequest({ handoff, cycle });
    const req = initialPcControlRequest(handoff, cycle.cycle_id);
    assert.ok(req);
    assert.equal(req!.body.stop_condition, B2_S2_CANARY_STOP_CONDITION);
    assert.ok(
      req!.body.authoritative_references.includes(
        "evidence/requests/OWATA-REQ-0055.md",
      ),
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canary driver fail-fast on rejected external builder result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-b2s2-ff-"));
  try {
    const store = ControlStore.open({
      stateDir: dir,
      idFactory: seqIds(),
    });
    const handoff = new HandoffStore(store);
    const project = store.createProject("ff-test");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: B2_S2_CANARY_WP_REF,
      baseSha: "a".repeat(40),
      maxDispatchRetries: 1,
    });

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: fakePc([
          {
            decision: "BUILD",
            rationale: "canary",
            authorized_finding_ids: [],
            rework_scope: null,
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
          },
        ]),
        builder: fakeBuilderReject(),
        reviewer: fakeReviewerIdle(),
      },
      { owner: "test", leaseMs: 60_000 },
    );

    const driven = await runB2FullCanaryDriver({
      handoff,
      dispatcher,
      cycleId: cycle.cycle_id,
      maxSteps: 12,
    });

    assert.equal(driven.status, B2_S2_CANARY_EXTERNAL_RESULT_REJECTED);
    assert.ok(driven.externalRejection);
    assert.equal(driven.initialPcPolicy, "DISPATCH_REVIEW");
    // With maxDispatchRetries=1, no second same-request attempt after reject.
    const attempts = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM dispatches WHERE cycle_id = ? AND target_role = 'builder'`,
      )
      .get(cycle.cycle_id) as { n: number };
    assert.equal(Number(attempts.n), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canary driver rejects initial BUILD+AWAIT_PC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-b2s2-await-"));
  try {
    const store = ControlStore.open({
      stateDir: dir,
      idFactory: seqIds(),
    });
    const handoff = new HandoffStore(store);
    const project = store.createProject("await-test");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: B2_S2_CANARY_WP_REF,
      baseSha: "a".repeat(40),
      maxDispatchRetries: 1,
    });

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: fakePc([
          {
            decision: "BUILD",
            rationale: "bad for canary",
            authorized_finding_ids: [],
            rework_scope: null,
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: { on_builder_candidate: "AWAIT_PC" },
          },
        ]),
        builder: fakeBuilderReject(),
        reviewer: fakeReviewerIdle(),
      },
      { owner: "test", leaseMs: 60_000 },
    );

    const driven = await runB2FullCanaryDriver({
      handoff,
      dispatcher,
      cycleId: cycle.cycle_id,
      maxSteps: 8,
    });

    assert.equal(driven.status, B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION);
    assert.equal(driven.initialPcPolicy, "AWAIT_PC");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC RETRY with null recovery_target_request_id is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-retry-null-"));
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("retry-null");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      maxDispatchRetries: 3,
    });
    assert.equal(
      handoff.requireCycle(cycle.cycle_id).recovery_target_request_id,
      null,
    );
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: fakePc([
          {
            decision: "RETRY",
            rationale: "not review routing",
            authorized_finding_ids: [],
            rework_scope: null,
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: null,
          },
        ]),
        builder: fakeBuilderReject(),
        reviewer: fakeReviewerIdle(),
      },
      { owner: "t", leaseMs: 5000 },
    );
    const step = await dispatcher.step(cycle.cycle_id);
    assert.equal(step.action, "result_invalid");
    assert.match(String(step.detail?.reason ?? ""), /recovery_target_request_id/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("general non-canary OWATA still permits AWAIT_PC BUILD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-await-ok-"));
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("await-ok");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "c".repeat(40),
      maxDispatchRetries: 3,
    });
    let builderCalls = 0;
    const builder: BuilderAdapter = {
      identity: { adapter_id: "fake-builder", role: "builder" },
      capabilities: () => [
        "repository_read",
        "repository_write",
        "exact_checkout",
        "command_execution",
      ],
      preflight: () => ({ ok: true, missing: [] }),
      async build(input) {
        builderCalls += 1;
        return {
          protocol: PROTOCOL_V1,
          envelope_id: `env_b_${builderCalls}`,
          kind: "builder_result",
          cycle_id: input.cycle.cycle_id,
          request_id: input.request.request_id,
          from_role: "builder",
          to_role: "program_control",
          created_at: new Date().toISOString(),
          body: {
            status: "CANDIDATE_READY",
            candidate_sha: "d".repeat(40),
            evidence_refs: ["e"],
            notes: null,
          },
        };
      },
    };
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: fakePc([
          {
            decision: "BUILD",
            rationale: null,
            authorized_finding_ids: [],
            rework_scope: null,
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: { on_builder_candidate: "AWAIT_PC" },
          },
        ]),
        builder,
        reviewer: fakeReviewerIdle(),
      },
      { owner: "t", leaseMs: 5000 },
    );
    await dispatcher.step(cycle.cycle_id);
    await dispatcher.step(cycle.cycle_id);
    assert.equal(
      handoff.requireCycle(cycle.cycle_id).policy.on_builder_candidate,
      "AWAIT_PC",
    );
    assert.equal(builderCalls, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("general Dispatcher still allows multi-attempt retry outside canary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-gen-retry-"));
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("gen-retry");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      maxDispatchRetries: 3,
    });
    let builderCalls = 0;
    const builder: BuilderAdapter = {
      identity: { adapter_id: "fake-builder", role: "builder" },
      capabilities: () => [
        "repository_read",
        "repository_write",
        "exact_checkout",
        "command_execution",
      ],
      preflight: () => ({ ok: true, missing: [] }),
      async build(input) {
        builderCalls += 1;
        if (builderCalls === 1) {
          return { not: "an-envelope" };
        }
        return {
          protocol: PROTOCOL_V1,
          envelope_id: `env_b_${builderCalls}`,
          kind: "builder_result",
          cycle_id: input.cycle.cycle_id,
          request_id: input.request.request_id,
          from_role: "builder",
          to_role: "program_control",
          created_at: new Date().toISOString(),
          body: {
            status: "CANDIDATE_READY",
            candidate_sha: "h".repeat(40),
            evidence_refs: ["e"],
            notes: null,
          },
        };
      },
    };
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: fakePc([
          {
            decision: "BUILD",
            rationale: null,
            authorized_finding_ids: [],
            rework_scope: null,
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: { on_builder_candidate: "AWAIT_PC" },
          },
        ]),
        builder,
        reviewer: fakeReviewerIdle(),
      },
      { owner: "t", leaseMs: 5000 },
    );
    await dispatcher.step(cycle.cycle_id);
    const first = await dispatcher.step(cycle.cycle_id);
    assert.equal(first.action, "result_invalid");
    assert.equal(builderCalls, 1);
    const second = await dispatcher.step(cycle.cycle_id);
    assert.equal(second.action, "builder_result");
    assert.equal(builderCalls, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scripted successful canary lineage BUILD→REWORK→PASS→ACCEPT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-b2s2-lineage-"));
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("lineage");
    const shaA = "1".repeat(40);
    const shaB = "2".repeat(40);
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: B2_S2_CANARY_WP_REF,
      baseSha: "0".repeat(40),
      maxDispatchRetries: 1,
    });

    let builderCalls = 0;
    let reviewerCalls = 0;
    const builder: BuilderAdapter = {
      identity: { adapter_id: "fake-builder", role: "builder" },
      capabilities: () => [
        "repository_read",
        "repository_write",
        "exact_checkout",
        "command_execution",
      ],
      preflight: () => ({ ok: true, missing: [] }),
      async build(input) {
        builderCalls += 1;
        const sha = builderCalls === 1 ? shaA : shaB;
        return {
          protocol: PROTOCOL_V1,
          envelope_id: `env_b_${builderCalls}`,
          kind: "builder_result",
          cycle_id: input.cycle.cycle_id,
          request_id: input.request.request_id,
          from_role: "builder",
          to_role: "program_control",
          created_at: new Date().toISOString(),
          body: {
            status: "CANDIDATE_READY",
            candidate_sha: sha,
            evidence_refs: [`e${builderCalls}`],
            notes: null,
          },
        };
      },
    };
    const reviewer: ReviewerAdapter = {
      identity: { adapter_id: "fake-reviewer", role: "reviewer" },
      capabilities: () => [
        "repository_read",
        "exact_checkout",
        "command_execution",
      ],
      preflight: () => ({ ok: true, missing: [] }),
      async review(input) {
        reviewerCalls += 1;
        const rework = reviewerCalls === 1;
        return {
          protocol: PROTOCOL_V1,
          envelope_id: `env_r_${reviewerCalls}`,
          kind: "reviewer_result",
          cycle_id: input.cycle.cycle_id,
          request_id: input.request.request_id,
          from_role: "reviewer",
          to_role: "program_control",
          created_at: new Date().toISOString(),
          body: {
            target_sha: input.request.body.target_sha ?? shaA,
            verdict: rework ? "REWORK" : "PASS",
            findings: rework
              ? [
                  {
                    finding_id: "F1",
                    severity: "high",
                    summary: "broken",
                  },
                ]
              : [],
            evidence_refs: [`r${reviewerCalls}`],
          },
        };
      },
    };

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: fakePc([
          {
            decision: "BUILD",
            rationale: null,
            authorized_finding_ids: [],
            rework_scope: null,
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
          },
          {
            decision: "REWORK",
            rationale: null,
            authorized_finding_ids: ["F1"],
            rework_scope: "F1",
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: null,
          },
          {
            decision: "ACCEPT",
            rationale: null,
            authorized_finding_ids: [],
            rework_scope: null,
            human_gate_purpose: null,
            human_gate_choices: null,
            install_policy: null,
          },
        ]),
        builder,
        reviewer,
      },
      { owner: "canary", leaseMs: 5000 },
    );

    const driven = await runB2FullCanaryDriver({
      handoff,
      dispatcher,
      cycleId: cycle.cycle_id,
      maxSteps: 24,
    });
    assert.equal(driven.status, "ACCEPTED");
    assert.equal(driven.initialPcPolicy, "DISPATCH_REVIEW");
    assert.equal(builderCalls, 2);
    assert.equal(reviewerCalls, 2);
    const decisions = handoff
      .listEnvelopes(cycle.cycle_id)
      .filter((e) => e.kind === "program_control_decision")
      .map((e) => (e.body as PcDecisionBody).decision);
    assert.deepEqual(decisions, ["BUILD", "REWORK", "ACCEPT"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
