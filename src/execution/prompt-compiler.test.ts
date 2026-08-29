import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPILER_TEMPLATE_VERSION,
  compileBuilderInstruction,
} from "./prompt-compiler.js";
import { PROTOCOL_V1, type CanonicalEnvelope, type ControlRequestBody } from "../control/protocol.js";
import type { CycleSnapshot } from "../control/adapters.js";

const cycle: CycleSnapshot = {
  cycle_id: "cyc_1",
  state: "DISPATCHING_BUILD",
  work_package_ref: "WP-003",
  base_sha: "abc123",
  latest_candidate_sha: null,
  accepted_candidate_sha: null,
  current_request_id: "req_1",
  policy: { on_builder_candidate: "AWAIT_PC" },
  policy_authorized_by_decision_id: null,
  recovery_target_request_id: null,
  recovery_lineage_id: null,
  recovery_reason: null,
};

const request: CanonicalEnvelope<ControlRequestBody> = {
  protocol: PROTOCOL_V1,
  envelope_id: "env_req",
  kind: "control_request",
  cycle_id: "cyc_1",
  request_id: "req_1",
  from_role: "program_control",
  to_role: "builder",
  created_at: "2026-06-01T00:00:00.000Z",
  body: {
    action: "BUILD",
    target_role: "builder",
    work_package_ref: "WP-003",
    base_sha: "abc123",
    target_sha: null,
    authoritative_references: ["work-packages/WP-003", "decisions/DEC-003-001"],
    required_capabilities: ["repository_read"],
    expected_result_kind: "builder_result",
    stop_condition: "bounded",
    authorized_by_decision_id: null,
    authorized_finding_ids: [],
    retry_of_request_id: null,
  },
};

test("compileBuilderInstruction is deterministic", () => {
  const a = compileBuilderInstruction({
    request,
    cycle,
    resultEnvelopeRelPath: "state/execution/dsp_1/result-envelope.json",
  });
  const b = compileBuilderInstruction({
    request,
    cycle,
    resultEnvelopeRelPath: "state/execution/dsp_1/result-envelope.json",
  });
  assert.equal(a.text, b.text);
  assert.equal(a.promptHash, b.promptHash);
  assert.equal(a.templateVersion, COMPILER_TEMPLATE_VERSION);
  assert.match(a.text, /abc123/);
  assert.doesNotMatch(a.text, /"findings"/);
  assert.doesNotMatch(a.text, /finding_id/);
});

test("compileBuilderInstruction changes when canonical fields change", () => {
  const base = compileBuilderInstruction({
    request,
    cycle,
    resultEnvelopeRelPath: "a.json",
  });
  const changed = compileBuilderInstruction({
    request: {
      ...request,
      body: { ...request.body, stop_condition: "different" },
    },
    cycle,
    resultEnvelopeRelPath: "a.json",
  });
  assert.notEqual(base.promptHash, changed.promptHash);
});
