import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEWER_COMPILER_TEMPLATE_VERSION,
  compileReviewerInstruction,
} from "./prompt-compiler.js";
import {
  PROTOCOL_V1,
  type CanonicalEnvelope,
  type ControlRequestBody,
} from "../control/protocol.js";
import type { CycleSnapshot } from "../control/adapters.js";

const cycle: CycleSnapshot = {
  cycle_id: "cyc_rev_1",
  state: "DISPATCHING_REVIEW",
  work_package_ref: "WP-003",
  base_sha: "baseaaa",
  latest_candidate_sha: "candbbb",
  accepted_candidate_sha: null,
  current_request_id: "req_rev_1",
  policy: { on_builder_candidate: "AWAIT_PC" },
  policy_authorized_by_decision_id: null,
  recovery_target_request_id: null,
  recovery_lineage_id: null,
  recovery_reason: null,
};

function makeRequest(
  overrides: Partial<ControlRequestBody> = {},
): CanonicalEnvelope<ControlRequestBody> {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_req_rev",
    kind: "control_request",
    cycle_id: "cyc_rev_1",
    request_id: "req_rev_1",
    from_role: "program_control",
    to_role: "reviewer",
    created_at: "2026-08-30T00:00:00.000Z",
    body: {
      action: "REVIEW",
      target_role: "reviewer",
      work_package_ref: "WP-003",
      base_sha: "baseaaa",
      target_sha: "candbbb",
      authoritative_references: ["work-packages/WP-003", "decisions/DEC-003-001"],
      required_capabilities: [
        "repository_read",
        "exact_checkout",
        "command_execution",
      ],
      expected_result_kind: "reviewer_result",
      stop_condition: "exact target_sha; no source write; return to PC",
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
      retry_of_request_id: null,
      ...overrides,
    },
  };
}

test("reviewer prompt hash is deterministic", () => {
  const a = compileReviewerInstruction({
    request: makeRequest(),
    cycle,
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  const b = compileReviewerInstruction({
    request: makeRequest(),
    cycle,
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  assert.equal(a.promptHash, b.promptHash);
  assert.equal(a.templateVersion, REVIEWER_COMPILER_TEMPLATE_VERSION);
  assert.match(a.text, /Independent Reviewer/);
  assert.match(a.text, /candbbb/);
  assert.match(a.text, /Do not modify/);
});

test("authority-bearing field change changes reviewer prompt hash", () => {
  const base = compileReviewerInstruction({
    request: makeRequest(),
    cycle,
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  const changedTarget = compileReviewerInstruction({
    request: makeRequest({ target_sha: "otherccc" }),
    cycle,
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  const changedStop = compileReviewerInstruction({
    request: makeRequest({ stop_condition: "different stop" }),
    cycle,
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  const changedRefs = compileReviewerInstruction({
    request: makeRequest({
      authoritative_references: ["work-packages/WP-003", "extra-ref"],
    }),
    cycle,
    resultEnvelopeRelPath: "/tmp/result-envelope.json",
  });
  assert.notEqual(base.promptHash, changedTarget.promptHash);
  assert.notEqual(base.promptHash, changedStop.promptHash);
  assert.notEqual(base.promptHash, changedRefs.promptHash);
});
