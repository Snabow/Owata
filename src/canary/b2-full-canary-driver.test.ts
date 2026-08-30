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
