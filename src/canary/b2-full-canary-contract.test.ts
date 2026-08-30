import assert from "node:assert/strict";
import test from "node:test";
import {
  B2_S2_CANARY_INITIAL_BUILD_POLICY_MARKER,
  B2_S2_CANARY_STOP_CONDITION,
  B2_S2_CANARY_WP_REF,
  isB2S2FullCanaryWorkPackage,
  stopConditionRequiresDispatchReview,
} from "./b2-full-canary-contract.js";
import { compileProgramControlInstruction } from "../program-control/prompt-compiler.js";
import type { CycleSnapshot } from "../control/adapters.js";
import type {
  CanonicalEnvelope,
  ControlRequestBody,
} from "../control/protocol.js";
import { PROTOCOL_V1 } from "../control/index.js";

test("B2-S2 canary contract markers are durable and recognizable", () => {
  assert.equal(isB2S2FullCanaryWorkPackage(B2_S2_CANARY_WP_REF), true);
  assert.equal(isB2S2FullCanaryWorkPackage("WP-003"), false);
  assert.equal(
    stopConditionRequiresDispatchReview(B2_S2_CANARY_STOP_CONDITION),
    true,
  );
  assert.equal(
    stopConditionRequiresDispatchReview("real Program Control; durable envelopes"),
    false,
  );
  assert.ok(
    B2_S2_CANARY_STOP_CONDITION.includes(
      B2_S2_CANARY_INITIAL_BUILD_POLICY_MARKER,
    ),
  );
});

function baseCycle(overrides: Partial<CycleSnapshot> = {}): CycleSnapshot {
  return {
    cycle_id: "cyc_test",
    state: "DISPATCHING_PC",
    work_package_ref: B2_S2_CANARY_WP_REF,
    base_sha: "a".repeat(40),
    latest_candidate_sha: null,
    accepted_candidate_sha: null,
    current_request_id: "req_pc",
    policy: { on_builder_candidate: "AWAIT_PC" },
    policy_authorized_by_decision_id: null,
    recovery_target_request_id: null,
    recovery_lineage_id: null,
    recovery_reason: null,
    ...overrides,
  };
}

function pcRequest(
  stopCondition: string,
): CanonicalEnvelope<ControlRequestBody> {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_req",
    kind: "control_request",
    cycle_id: "cyc_test",
    request_id: "req_pc",
    from_role: "dispatcher",
    to_role: "program_control",
    created_at: "2026-08-30T00:00:00.000Z",
    body: {
      action: "DECIDE",
      target_role: "program_control",
      work_package_ref: B2_S2_CANARY_WP_REF,
      base_sha: "a".repeat(40),
      target_sha: null,
      authoritative_references: ["evidence/requests/OWATA-REQ-0055.md"],
      required_capabilities: ["repository_read"],
      expected_result_kind: "program_control_decision",
      stop_condition: stopCondition,
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
      retry_of_request_id: null,
    },
  };
}

test("PC prompt surfaces DISPATCH_REVIEW canary contract and RETRY rules", () => {
  const compiled = compileProgramControlInstruction({
    request: pcRequest(B2_S2_CANARY_STOP_CONDITION),
    cycle: baseCycle(),
    envelopes: [],
    resultEnvelopeRelPath: "execution/dsp_1/result-envelope.json",
  });

  assert.match(compiled.text, /INITIAL_BUILD_POLICY=DISPATCH_REVIEW/);
  assert.match(
    compiled.text,
    /install_policy\.on_builder_candidate=DISPATCH_REVIEW/,
  );
  assert.match(compiled.text, /AWAIT_PC does NOT satisfy this canary contract/);
  assert.match(
    compiled.text,
    /RETRY: allowed ONLY when cycle\.recovery_target_request_id is non-null/,
  );
  assert.match(
    compiled.text,
    /Use RETRY to mean "route the current candidate to Reviewer"/,
  );
  assert.match(
    compiled.text,
    /Return RETRY when recovery_target_request_id is null/,
  );
});

test("PC prompt omits B2-S2 canary contract without durable marker", () => {
  const compiled = compileProgramControlInstruction({
    request: pcRequest("real Program Control; durable envelopes; no Browser Relay"),
    cycle: baseCycle({ work_package_ref: "WP-OTHER" }),
    envelopes: [],
    resultEnvelopeRelPath: "execution/dsp_1/result-envelope.json",
  });

  assert.doesNotMatch(
    compiled.text,
    /B2-S2 full no-relay canary durable contract/,
  );
  assert.match(
    compiled.text,
    /RETRY: allowed ONLY when cycle\.recovery_target_request_id is non-null/,
  );
});
