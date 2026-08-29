import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPILER_TEMPLATE_VERSION,
  compileBuilderInstruction,
} from "./prompt-compiler.js";
import { ControlError } from "../control/types.js";
import {
  PROTOCOL_V1,
  type CanonicalEnvelope,
  type ControlRequestBody,
} from "../control/protocol.js";
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

const decisionEnv: CanonicalEnvelope = {
  protocol: PROTOCOL_V1,
  envelope_id: "env_dec_1",
  kind: "program_control_decision",
  cycle_id: "cyc_1",
  request_id: "req_1",
  from_role: "program_control",
  to_role: "dispatcher",
  created_at: "2026-06-01T00:00:01.000Z",
  body: {
    decision: "REWORK",
    rationale: "fix F02",
    authorized_finding_ids: ["f_high_1"],
    rework_scope: "compiler authority fields",
    human_gate_purpose: null,
    human_gate_choices: null,
    install_policy: null,
  },
};

const reviewerEnv: CanonicalEnvelope = {
  protocol: PROTOCOL_V1,
  envelope_id: "env_rev_1",
  kind: "reviewer_result",
  cycle_id: "cyc_1",
  request_id: "req_review",
  from_role: "reviewer",
  to_role: "program_control",
  created_at: "2026-06-01T00:00:00.500Z",
  body: {
    target_sha: "cand_1",
    verdict: "REWORK",
    findings: [
      {
        finding_id: "f_high_1",
        severity: "HIGH",
        summary: "prompt compiler omits authority fields",
      },
      {
        finding_id: "f_unauth",
        severity: "LOW",
        summary: "should never appear unless authorized",
      },
    ],
    evidence_refs: [],
  },
};

test("compileBuilderInstruction is deterministic for BUILD without findings", () => {
  const a = compileBuilderInstruction({
    request,
    cycle,
    resultEnvelopeRelPath: "state/execution/dsp_1/result-envelope.json",
    envelopes: [],
  });
  const b = compileBuilderInstruction({
    request,
    cycle,
    resultEnvelopeRelPath: "state/execution/dsp_1/result-envelope.json",
    envelopes: [],
  });
  assert.equal(a.text, b.text);
  assert.equal(a.promptHash, b.promptHash);
  assert.equal(a.templateVersion, COMPILER_TEMPLATE_VERSION);
  assert.match(a.text, /abc123/);
  assert.match(a.text, /"target_role"/);
  assert.match(a.text, /"required_capabilities"/);
  assert.match(a.text, /"authorized_by_decision_id"/);
  assert.match(a.text, /"authorized_finding_ids"/);
  assert.match(a.text, /"retry_of_request_id"/);
});

test("compileBuilderInstruction changes when authority-bearing fields change", () => {
  const base = compileBuilderInstruction({
    request,
    cycle,
    resultEnvelopeRelPath: "a.json",
    envelopes: [],
  });

  const cases: Array<(r: typeof request) => typeof request> = [
    (r) => ({
      ...r,
      body: { ...r.body, stop_condition: "different" },
    }),
    (r) => ({
      ...r,
      body: { ...r.body, retry_of_request_id: "req_prior" },
    }),
    (r) => ({
      ...r,
      body: {
        ...r.body,
        required_capabilities: ["repository_read", "command_execution"],
      },
    }),
    (r) => ({
      ...r,
      body: { ...r.body, target_role: "reviewer" },
    }),
  ];

  for (const mutate of cases) {
    const changed = compileBuilderInstruction({
      request: mutate(request),
      cycle,
      resultEnvelopeRelPath: "a.json",
      envelopes: [],
    });
    assert.notEqual(base.promptHash, changed.promptHash);
  }
});

test("compileBuilderInstruction includes exact authorized findings and decision", () => {
  const reworkRequest: CanonicalEnvelope<ControlRequestBody> = {
    ...request,
    request_id: "req_rework",
    body: {
      ...request.body,
      action: "REWORK",
      authorized_by_decision_id: "env_dec_1",
      authorized_finding_ids: ["f_high_1"],
    },
  };
  const compiled = compileBuilderInstruction({
    request: reworkRequest,
    cycle,
    resultEnvelopeRelPath: "a.json",
    envelopes: [decisionEnv, reviewerEnv],
  });
  assert.match(compiled.text, /f_high_1/);
  assert.match(compiled.text, /prompt compiler omits authority fields/);
  assert.match(compiled.text, /compiler authority fields/);
  assert.doesNotMatch(compiled.text, /f_unauth/);
  assert.doesNotMatch(compiled.text, /should never appear unless authorized/);
});

test("compileBuilderInstruction hash changes with authorized_finding_ids", () => {
  const withFinding: CanonicalEnvelope<ControlRequestBody> = {
    ...request,
    body: {
      ...request.body,
      action: "REWORK",
      authorized_by_decision_id: "env_dec_1",
      authorized_finding_ids: ["f_high_1"],
    },
  };
  const a = compileBuilderInstruction({
    request: withFinding,
    cycle,
    resultEnvelopeRelPath: "a.json",
    envelopes: [decisionEnv, reviewerEnv],
  });
  const decisionEnv2: CanonicalEnvelope = {
    ...decisionEnv,
    envelope_id: "env_dec_2",
    body: {
      ...(decisionEnv.body as object),
      authorized_finding_ids: ["f_unauth"],
    } as never,
  };
  const b = compileBuilderInstruction({
    request: {
      ...withFinding,
      body: {
        ...withFinding.body,
        authorized_by_decision_id: "env_dec_2",
        authorized_finding_ids: ["f_unauth"],
      },
    },
    cycle,
    resultEnvelopeRelPath: "a.json",
    envelopes: [decisionEnv2, reviewerEnv],
  });
  assert.notEqual(a.promptHash, b.promptHash);
});

test("compileBuilderInstruction hash changes with authorized_by_decision_id", () => {
  const decisionEnvB: CanonicalEnvelope = {
    ...decisionEnv,
    envelope_id: "env_dec_alt",
    body: {
      ...(decisionEnv.body as object),
      rework_scope: "different scope",
    } as never,
  };
  const baseReq: CanonicalEnvelope<ControlRequestBody> = {
    ...request,
    body: {
      ...request.body,
      action: "REWORK",
      authorized_by_decision_id: "env_dec_1",
      authorized_finding_ids: ["f_high_1"],
    },
  };
  const a = compileBuilderInstruction({
    request: baseReq,
    cycle,
    resultEnvelopeRelPath: "a.json",
    envelopes: [decisionEnv, reviewerEnv],
  });
  const b = compileBuilderInstruction({
    request: {
      ...baseReq,
      body: { ...baseReq.body, authorized_by_decision_id: "env_dec_alt" },
    },
    cycle,
    resultEnvelopeRelPath: "a.json",
    envelopes: [decisionEnvB, reviewerEnv],
  });
  assert.notEqual(a.promptHash, b.promptHash);
});

test("compileBuilderInstruction fails closed on unresolved authorized finding", () => {
  assert.throws(
    () =>
      compileBuilderInstruction({
        request: {
          ...request,
          body: {
            ...request.body,
            action: "REWORK",
            authorized_by_decision_id: "env_dec_1",
            authorized_finding_ids: ["f_missing"],
          },
        },
        cycle,
        resultEnvelopeRelPath: "a.json",
        envelopes: [decisionEnv, reviewerEnv],
      }),
    (err: unknown) =>
      err instanceof ControlError &&
      err.code === "RESULT_INVALID" &&
      /f_missing/.test(err.message),
  );
});

test("compileBuilderInstruction fails closed on unresolved decision id", () => {
  assert.throws(
    () =>
      compileBuilderInstruction({
        request: {
          ...request,
          body: {
            ...request.body,
            authorized_by_decision_id: "env_missing",
          },
        },
        cycle,
        resultEnvelopeRelPath: "a.json",
        envelopes: [decisionEnv],
      }),
    (err: unknown) =>
      err instanceof ControlError &&
      err.code === "RESULT_INVALID" &&
      /env_missing/.test(err.message),
  );
});
