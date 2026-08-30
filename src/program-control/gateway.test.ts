import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlError } from "../control/types.js";
import {
  ControlStore,
  Dispatcher,
  HandoffStore,
  PROTOCOL_V1,
} from "../control/index.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "../control/fixtures/fake-adapters.js";
import type {
  CanonicalEnvelope,
  ControlRequestBody,
  PcDecisionBody,
} from "../control/protocol.js";
import type { CycleSnapshot } from "../control/adapters.js";
import { GatewayProgramControlAdapter } from "./gateway.js";
import { ScriptedProgramControlBinding } from "./fixtures/scripted-binding.js";
import {
  PROGRAM_CONTROL_COMPILER_TEMPLATE_VERSION,
  compileProgramControlInstruction,
} from "./prompt-compiler.js";
import { assertStrictProgramControlDecision } from "./strict-result.js";
import { assertPcDecisionAuthority } from "./authority.js";

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
    install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
    ...partial,
  };
}

function makeCycle(overrides: Partial<CycleSnapshot> = {}): CycleSnapshot {
  return {
    cycle_id: "cyc_pc",
    state: "DISPATCHING_PC",
    work_package_ref: "WP-003-B2-S2",
    base_sha: "baseaaa",
    latest_candidate_sha: "candbbb",
    accepted_candidate_sha: null,
    current_request_id: "req_pc",
    policy: { on_builder_candidate: "DISPATCH_REVIEW" },
    policy_authorized_by_decision_id: "env_policy",
    recovery_target_request_id: null,
    recovery_lineage_id: null,
    recovery_reason: null,
    ...overrides,
  };
}

function makeRequest(): CanonicalEnvelope<ControlRequestBody> {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_req_pc",
    kind: "control_request",
    cycle_id: "cyc_pc",
    request_id: "req_pc",
    from_role: "dispatcher",
    to_role: "program_control",
    created_at: "2026-08-30T00:00:00.000Z",
    body: {
      action: "DECIDE",
      target_role: "program_control",
      work_package_ref: "WP-003-B2-S2",
      base_sha: "baseaaa",
      target_sha: "candbbb",
      authoritative_references: ["work-packages/WP-003"],
      required_capabilities: ["repository_read"],
      expected_result_kind: "program_control_decision",
      stop_condition: "real Program Control; durable envelopes; no Browser Relay",
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
      retry_of_request_id: null,
    },
  };
}

function decisionEnvelope(
  body: PcDecisionBody,
  overrides: Partial<CanonicalEnvelope> = {},
): unknown {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_pc_ok",
    kind: "program_control_decision",
    cycle_id: "cyc_pc",
    request_id: "req_pc",
    from_role: "program_control",
    to_role: "dispatcher",
    created_at: "2026-08-30T00:01:00.000Z",
    body,
    ...overrides,
  };
}

test("real PC path never falls back to fake", async () => {
  const binding = new ScriptedProgramControlBinding();
  binding.probeResult = { ok: false, authReady: false, detail: "down" };
  const root = mkdtempSync(join(tmpdir(), "owata-pc-nofake-"));
  try {
    const adapter = new GatewayProgramControlAdapter({
      binding,
      stateDir: join(root, "state"),
    });
    await adapter.refreshProbe();
    assert.equal(adapter.identity.adapter_id, "gateway-program-control");
    const fake = new FakeProgramControlAdapter([], {
      id: () => "x",
      now: () => "t",
    });
    assert.notEqual(adapter.identity.adapter_id, fake.identity.adapter_id);
    const pre = adapter.preflight(["repository_read"]);
    assert.equal(pre.ok, false);
    assert.equal(binding.startCount, 0);
  } finally {
    cleanup(root);
  }
});

test("authReady=false blocks Program Control spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-pc-auth-"));
  try {
    const binding = new ScriptedProgramControlBinding();
    binding.probeResult = {
      ok: true,
      authReady: false,
      runtimeVersion: "x",
      detail: "not logged in",
    };
    const adapter = new GatewayProgramControlAdapter({
      binding,
      stateDir: join(root, "state"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.decide({
          cycle: makeCycle(),
          envelopes: [],
          request: makeRequest(),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "CREDENTIAL_UNAVAILABLE",
    );
    assert.equal(binding.startCount, 0);
  } finally {
    cleanup(root);
  }
});

test("failClosedNoFakeFallback=false is rejected", () => {
  const binding = new ScriptedProgramControlBinding();
  assert.throws(
    () =>
      new GatewayProgramControlAdapter({
        binding,
        stateDir: "/tmp",
        failClosedNoFakeFallback: false,
      }),
    (err: unknown) => err instanceof ControlError && err.code === "PROTOCOL",
  );
});

test("PC prompt hash is deterministic; authority fields change hash", () => {
  const cycle = makeCycle();
  const request = makeRequest();
  const a = compileProgramControlInstruction({
    request,
    cycle,
    envelopes: [],
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  const b = compileProgramControlInstruction({
    request,
    cycle,
    envelopes: [],
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  assert.equal(a.promptHash, b.promptHash);
  assert.equal(a.templateVersion, PROGRAM_CONTROL_COMPILER_TEMPLATE_VERSION);

  const changedStop = compileProgramControlInstruction({
    request: {
      ...request,
      body: { ...request.body, stop_condition: "different" },
    },
    cycle,
    envelopes: [],
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  const changedCandidate = compileProgramControlInstruction({
    request,
    cycle: { ...cycle, latest_candidate_sha: "otherccc" },
    envelopes: [],
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  assert.notEqual(a.promptHash, changedStop.promptHash);
  assert.notEqual(a.promptHash, changedCandidate.promptHash);
});

test("strict PC result rejects malformed / wrong role / extra props", () => {
  assert.throws(
    () => assertStrictProgramControlDecision({ not: "envelope" }),
    (err: unknown) => err instanceof ControlError && err.code === "RESULT_INVALID",
  );
  assert.throws(
    () =>
      assertStrictProgramControlDecision(
        decisionEnvelope(pcDecision({ decision: "BUILD" }), {
          from_role: "reviewer",
        }),
      ),
    (err: unknown) =>
      err instanceof ControlError && /from_role must be program_control/.test(err.message),
  );
  assert.throws(
    () =>
      assertStrictProgramControlDecision(
        decisionEnvelope(pcDecision({ decision: "BUILD" }), {
          to_role: "program_control",
        }),
      ),
    (err: unknown) =>
      err instanceof ControlError && /to_role must be dispatcher/.test(err.message),
  );
  assert.throws(
    () =>
      assertStrictProgramControlDecision({
        ...(decisionEnvelope(pcDecision({ decision: "BUILD" })) as object),
        extra: true,
      }),
    (err: unknown) =>
      err instanceof ControlError && /additional property/.test(err.message),
  );
});

test("gateway rejects cycle/request correlation mismatches", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-pc-corr-"));
  try {
    const binding = new ScriptedProgramControlBinding();
    binding.onStart = (attempt) => {
      binding.writeResult(
        attempt.resultEnvelopePath,
        decisionEnvelope(pcDecision({ decision: "BUILD" }), {
          cycle_id: "wrong_cycle",
        }),
      );
    };
    const adapter = new GatewayProgramControlAdapter({
      binding,
      stateDir: join(root, "state"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.decide({
          cycle: makeCycle(),
          envelopes: [],
          request: makeRequest(),
          dispatch: {
            dispatch_id: "d_corr",
            attempt_number: 1,
            fence_token: "f",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "RESULT_STALE",
    );
  } finally {
    cleanup(root);
  }
});

test("authority ACCEPT / REWORK gates", () => {
  const cycle = makeCycle({ latest_candidate_sha: "sha-a" });
  const pass: CanonicalEnvelope = {
    protocol: PROTOCOL_V1,
    envelope_id: "env_rev_pass",
    kind: "reviewer_result",
    cycle_id: "cyc_pc",
    request_id: "req_rev",
    from_role: "reviewer",
    to_role: "program_control",
    created_at: "2026-08-30T00:02:00.000Z",
    body: {
      target_sha: "sha-a",
      verdict: "PASS",
      findings: [],
      evidence_refs: [],
    },
  };
  const rework: CanonicalEnvelope = {
    protocol: PROTOCOL_V1,
    envelope_id: "env_rev_rework",
    kind: "reviewer_result",
    cycle_id: "cyc_pc",
    request_id: "req_rev",
    from_role: "reviewer",
    to_role: "program_control",
    created_at: "2026-08-30T00:01:00.000Z",
    body: {
      target_sha: "sha-a",
      verdict: "REWORK",
      findings: [
        { finding_id: "F1", severity: "high", summary: "broken" },
      ],
      evidence_refs: [],
    },
  };

  assert.throws(
    () =>
      assertPcDecisionAuthority({
        decision: pcDecision({ decision: "ACCEPT" }),
        cycle,
        envelopes: [rework],
      }),
    (err: unknown) =>
      err instanceof ControlError && /ACCEPT requires latest Reviewer PASS/.test(err.message),
  );

  assert.doesNotThrow(() =>
    assertPcDecisionAuthority({
      decision: pcDecision({ decision: "ACCEPT" }),
      cycle,
      envelopes: [rework, pass],
    }),
  );

  assert.throws(
    () =>
      assertPcDecisionAuthority({
        decision: pcDecision({
          decision: "REWORK",
          authorized_finding_ids: ["INVENTED"],
        }),
        cycle,
        envelopes: [rework],
      }),
    (err: unknown) =>
      err instanceof ControlError && /invented\/stale/.test(err.message),
  );

  assert.doesNotThrow(() =>
    assertPcDecisionAuthority({
      decision: pcDecision({
        decision: "REWORK",
        authorized_finding_ids: ["F1"],
      }),
      cycle,
      envelopes: [rework],
    }),
  );

  assert.throws(
    () =>
      assertPcDecisionAuthority({
        decision: pcDecision({ decision: "ACCEPT" }),
        cycle: { ...cycle, latest_candidate_sha: "sha-newer" },
        envelopes: [pass],
      }),
    (err: unknown) =>
      err instanceof ControlError &&
      /requires a Reviewer result for latest candidate/.test(err.message),
  );
});

test("offline scripted full loop BUILD→REWORK→PC REWORK→PASS→ACCEPT", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-pc-full-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const store = ControlStore.open({
      stateDir: join(root, "state"),
      idFactory: seqIds(),
    });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };

    const project = store.createProject("b2-s2-offline");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003-B2-S2",
      baseSha: "base-0",
      maxDispatchRetries: 4,
    });

    const pcBodies: PcDecisionBody[] = [
      pcDecision({
        decision: "BUILD",
        rationale: "start",
        install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
      }),
      pcDecision({
        decision: "REWORK",
        rationale: "authorize finding",
        authorized_finding_ids: ["F_STATUS"],
        rework_scope: "F_STATUS",
      }),
      pcDecision({
        decision: "ACCEPT",
        rationale: "pass",
      }),
    ];
    let pcIndex = 0;

    const binding = new ScriptedProgramControlBinding();
    binding.onStart = (attempt) => {
      const body = pcBodies[pcIndex++];
      if (!body) throw new Error("PC script exhausted");
      const instruction = readFileSync(attempt.instructionPath, "utf8");
      assert.match(instruction, /Program Control/);
      assert.ok(existsSync(attempt.artifactsDir));
      const reqId = handoff.requireCycle(cycle.cycle_id).current_request_id;
      binding.writeResult(attempt.resultEnvelopePath, {
        protocol: PROTOCOL_V1,
        envelope_id: clock.id("env"),
        kind: "program_control_decision",
        cycle_id: cycle.cycle_id,
        request_id: reqId,
        from_role: "program_control",
        to_role: "dispatcher",
        created_at: clock.now(),
        body,
      });
    };

    const gateway = new GatewayProgramControlAdapter({
      binding,
      stateDir: join(root, "state"),
      clock,
    });
    await gateway.refreshProbe();

    const builder = new FakeBuilderAdapter(
      [
        { status: "CANDIDATE_READY", candidate_sha: "sha-a" },
        { status: "CANDIDATE_READY", candidate_sha: "sha-b" },
      ],
      clock,
    );
    const reviewer = new FakeReviewerAdapter(
      [
        {
          verdict: "REWORK",
          findings: [
            {
              finding_id: "F_STATUS",
              severity: "high",
              summary: "STATUS broken",
            },
          ],
        },
        { verdict: "PASS" },
      ],
      clock,
    );

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: gateway,
        builder,
        reviewer,
      },
      { owner: "pc-offline", leaseMs: 60_000, heartbeatMs: 0 },
    );

    const final = await dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(final.cycle.state, "ACCEPTED");
    assert.equal(builder.invocations, 2);
    assert.equal(reviewer.invocations, 2);
    assert.equal(binding.startCount, 3);
    assert.equal(final.cycle.accepted_candidate_sha, "sha-b");

    const decisions = handoff
      .listEnvelopes(cycle.cycle_id)
      .filter((e) => e.kind === "program_control_decision")
      .map((e) => (e.body as PcDecisionBody).decision);
    assert.deepEqual(decisions, ["BUILD", "REWORK", "ACCEPT"]);

    const reviews = handoff
      .listEnvelopes(cycle.cycle_id)
      .filter((e) => e.kind === "reviewer_result")
      .map((e) => (e.body as { verdict: string }).verdict);
    assert.deepEqual(reviews, ["REWORK", "PASS"]);

    store.close();
  } finally {
    cleanup(root);
  }
});
