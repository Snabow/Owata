import { PROTOCOL_V1 } from "../control/protocol.js";
import type {
  CanonicalEnvelope,
  ControlRequestBody,
  PcDecisionBody,
} from "../control/protocol.js";
import type { HandoffStore, CycleRecord, DispatchRecord } from "../control/handoff.js";
import { ControlError } from "../control/types.js";

/**
 * B2-S2 full no-relay canary durable contract markers (existing fields only).
 * Not universal OWATA semantics — synthetic canary scope.
 */
export const B2_S2_CANARY_WP_REF = "WP-003-B2-S2";

export const B2_S2_CANARY_INITIAL_BUILD_POLICY_MARKER =
  "INITIAL_BUILD_POLICY=DISPATCH_REVIEW";

export const B2_S2_CANARY_STOP_CONDITION =
  "B2-S2 full no-relay canary; " +
  `${B2_S2_CANARY_INITIAL_BUILD_POLICY_MARKER}; ` +
  "initial decision=BUILD with install_policy.on_builder_candidate=DISPATCH_REVIEW; " +
  "AWAIT_PC does NOT satisfy this canary; " +
  "first candidate must reach Reviewer before another Program Control semantic decision; " +
  "Browser Relay prohibited as product transport; " +
  "real Program Control; durable envelopes only";

export const B2_S2_CANARY_AUTHORITATIVE_REFS = [
  "work-packages/WP-003-B2-S2",
  "work-packages/WP-003.md",
  "decisions/DEC-003-001-wp003-architecture.md",
  "decisions/DEC-003-004-real-program-control-full-no-relay.md",
  "evidence/wp-003-b2-s2.md",
  "evidence/requests/OWATA-REQ-0055.md",
] as const;

export const B2_S2_CANARY_EXTERNAL_RESULT_REJECTED =
  "B2_S2_CANARY_EXTERNAL_RESULT_REJECTED";

export const B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION =
  "B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION";

export function isB2S2FullCanaryWorkPackage(ref: string): boolean {
  return ref === B2_S2_CANARY_WP_REF;
}

export function stopConditionRequiresDispatchReview(
  stopCondition: string | null | undefined,
): boolean {
  return String(stopCondition ?? "").includes(
    B2_S2_CANARY_INITIAL_BUILD_POLICY_MARKER,
  );
}

export function controlRequestRequiresInitialDispatchReview(
  body: ControlRequestBody,
): boolean {
  if (stopConditionRequiresDispatchReview(body.stop_condition)) return true;
  return body.authoritative_references.some((r) =>
    r.includes(B2_S2_CANARY_INITIAL_BUILD_POLICY_MARKER),
  );
}

/**
 * Seed the *initial* Program Control Control Request with durable canary
 * contract fields. Canary-local only — does not modify generic Dispatcher.
 */
export function seedB2S2InitialPcControlRequest(args: {
  handoff: HandoffStore;
  cycle: CycleRecord;
}): CycleRecord {
  const { handoff, cycle } = args;
  if (cycle.state !== "AWAITING_PC" || cycle.current_request_id != null) {
    throw new ControlError(
      "PROTOCOL",
      "B2-S2 canary seed requires AWAITING_PC with no current request",
    );
  }
  const ts = handoff.store.now().toISOString();
  const requestId = handoff.store.nextId("req");
  const body: ControlRequestBody = {
    action: "DECIDE",
    target_role: "program_control",
    work_package_ref: cycle.work_package_ref,
    base_sha: cycle.base_sha,
    target_sha: cycle.latest_candidate_sha,
    authoritative_references: [...B2_S2_CANARY_AUTHORITATIVE_REFS],
    required_capabilities: ["repository_read"],
    expected_result_kind: "program_control_decision",
    stop_condition: B2_S2_CANARY_STOP_CONDITION,
    authorized_by_decision_id: null,
    authorized_finding_ids: [],
    retry_of_request_id: null,
  };
  return handoff.store.runImmediate(() => {
    handoff.persistEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: handoff.store.nextId("env"),
      kind: "control_request",
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      from_role: "dispatcher",
      to_role: "program_control",
      created_at: ts,
      body,
    });
    handoff.store.appendEvent("cycle.request_persisted", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: cycle.cycle_id,
        request_id: requestId,
        action: "DECIDE",
        target_role: "program_control",
        canary_initial_build_policy: "DISPATCH_REVIEW",
      },
    });
    return handoff.transition(cycle.cycle_id, "DISPATCHING_PC", {
      current_request_id: requestId,
    });
  });
}

/**
 * Canary-local gate: first accepted PC BUILD must install DISPATCH_REVIEW.
 * Does not remove AWAIT_PC from general OWATA.
 */
export function assertInitialCanaryBuildPolicy(decision: PcDecisionBody): void {
  if (decision.decision !== "BUILD") {
    throw new ControlError(
      B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION,
      `B2-S2 canary initial PC decision must be BUILD, got ${decision.decision}`,
    );
  }
  const policy = decision.install_policy?.on_builder_candidate;
  if (policy !== "DISPATCH_REVIEW") {
    throw new ControlError(
      B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION,
      `B2-S2 canary initial BUILD must install DISPATCH_REVIEW; got ${policy ?? "null"} (AWAIT_PC does not satisfy this canary)`,
    );
  }
}

export interface ExternalRejectionEvidence {
  role: string;
  request_id: string;
  dispatch_id: string;
  attempt_number: number;
  failure_class: string | null;
  detail: string | null;
}

export function findRejectedDispatchesViaStore(
  handoff: HandoffStore,
  cycleId: string,
): DispatchRecord[] {
  const rows = handoff.store.db
    .prepare(
      `SELECT * FROM dispatches WHERE cycle_id = ? AND state = 'REJECTED'
       ORDER BY attempt_number ASC`,
    )
    .all(cycleId) as Array<Record<string, unknown>>;
  return rows.map(rowToDispatch);
}

export function toExternalRejectionEvidence(
  dispatch: DispatchRecord,
): ExternalRejectionEvidence {
  return {
    role: dispatch.target_role,
    request_id: dispatch.request_id,
    dispatch_id: dispatch.dispatch_id,
    attempt_number: dispatch.attempt_number,
    failure_class: dispatch.failure_class,
    detail: dispatch.failure_detail,
  };
}

export function initialPcControlRequest(
  handoff: HandoffStore,
  cycleId: string,
): CanonicalEnvelope<ControlRequestBody> | null {
  const envelopes = handoff.listEnvelopes(cycleId);
  const first = envelopes.find(
    (e) =>
      e.kind === "control_request" &&
      (e.body as ControlRequestBody).target_role === "program_control",
  );
  return (first as CanonicalEnvelope<ControlRequestBody> | undefined) ?? null;
}

function rowToDispatch(row: Record<string, unknown>): DispatchRecord {
  return {
    dispatch_id: String(row.dispatch_id),
    cycle_id: String(row.cycle_id),
    request_id: String(row.request_id),
    attempt_number: Number(row.attempt_number),
    fence_token: String(row.fence_token),
    owner: String(row.owner),
    target_role: String(row.target_role) as DispatchRecord["target_role"],
    state: String(row.state) as DispatchRecord["state"],
    lease_expires_at: String(row.lease_expires_at),
    result_envelope_id:
      row.result_envelope_id == null ? null : String(row.result_envelope_id),
    failure_class:
      row.failure_class == null
        ? null
        : (String(row.failure_class) as DispatchRecord["failure_class"]),
    failure_detail:
      row.failure_detail == null ? null : String(row.failure_detail),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
