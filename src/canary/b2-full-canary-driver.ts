import type { Dispatcher, StepResult } from "../control/dispatcher.js";
import type { HandoffStore, CycleRecord, DispatchRecord } from "../control/handoff.js";
import type { PcDecisionBody } from "../control/protocol.js";
import { ControlError } from "../control/types.js";
import {
  B2_S2_CANARY_EXTERNAL_RESULT_REJECTED,
  B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION,
  assertInitialCanaryBuildPolicy,
  findRejectedDispatchesViaStore,
  seedB2S2InitialPcControlRequest,
  toExternalRejectionEvidence,
  type ExternalRejectionEvidence,
} from "./b2-full-canary-contract.js";

const FAIL_FAST_STEP_ACTIONS = new Set([
  "result_invalid",
  "result_stale",
  "runtime_error",
  "adapter_role_mismatch",
  "capability_block",
  "retry_budget",
]);

export interface B2FullCanaryDriverResult {
  cycle: CycleRecord;
  steps: StepResult[];
  status:
    | "RUNNING"
    | "ACCEPTED"
    | typeof B2_S2_CANARY_EXTERNAL_RESULT_REJECTED
    | typeof B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION
    | "CANARY_INVOCATION_BUDGET_EXCEEDED"
    | "MAX_STEPS"
    | "HUMAN_GATE"
    | "ABORTED"
    | "RECOVERY_REQUIRED"
    | "OTHER";
  externalRejection: ExternalRejectionEvidence | null;
  initialPcPolicy: "DISPATCH_REVIEW" | "AWAIT_PC" | "OTHER" | "NONE";
  detail: string | null;
}

function acceptedPcDecisions(
  handoff: HandoffStore,
  cycleId: string,
): PcDecisionBody[] {
  return handoff
    .listEnvelopes(cycleId)
    .filter((e) => e.kind === "program_control_decision")
    .map((e) => e.body as PcDecisionBody);
}

function classifyTerminal(
  cycle: CycleRecord,
): B2FullCanaryDriverResult["status"] {
  if (cycle.state === "ACCEPTED") return "ACCEPTED";
  if (cycle.state === "HUMAN_GATE") return "HUMAN_GATE";
  if (cycle.state === "ABORTED") return "ABORTED";
  if (cycle.state === "RECOVERY_REQUIRED") return "RECOVERY_REQUIRED";
  return "OTHER";
}

/**
 * Canary-local driver: seed durable initial PC contract, step manually,
 * fail-fast on any rejected/runtime-failed external dispatch.
 * Does not change product Dispatcher retry semantics.
 */
export async function runB2FullCanaryDriver(args: {
  handoff: HandoffStore;
  dispatcher: Dispatcher;
  cycleId: string;
  maxSteps?: number;
}): Promise<B2FullCanaryDriverResult> {
  const { handoff, dispatcher, cycleId } = args;
  const maxSteps = args.maxSteps ?? 48;
  const steps: StepResult[] = [];
  let initialPcPolicy: B2FullCanaryDriverResult["initialPcPolicy"] = "NONE";
  let initialPcValidated = false;

  let cycle = handoff.requireCycle(cycleId);
  if (cycle.state === "AWAITING_PC" && cycle.current_request_id == null) {
    cycle = seedB2S2InitialPcControlRequest({ handoff, cycle });
  }

  const seenRejected = new Set<string>();

  for (let i = 0; i < maxSteps; i += 1) {
    cycle = handoff.requireCycle(cycleId);
    if (
      cycle.state === "ACCEPTED" ||
      cycle.state === "ABORTED" ||
      cycle.state === "HUMAN_GATE"
    ) {
      return {
        cycle,
        steps,
        status: classifyTerminal(cycle),
        externalRejection: null,
        initialPcPolicy,
        detail: null,
      };
    }

    let step: StepResult;
    try {
      step = await dispatcher.step(cycleId);
    } catch (err) {
      if (
        err instanceof ControlError &&
        err.code === "CANARY_INVOCATION_BUDGET_EXCEEDED"
      ) {
        return {
          cycle: handoff.requireCycle(cycleId),
          steps,
          status: "CANARY_INVOCATION_BUDGET_EXCEEDED",
          externalRejection: null,
          initialPcPolicy,
          detail: err.message,
        };
      }
      if (
        err instanceof ControlError &&
        err.code === B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION
      ) {
        return {
          cycle: handoff.requireCycle(cycleId),
          steps,
          status: B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION,
          externalRejection: null,
          initialPcPolicy,
          detail: err.message,
        };
      }
      throw err;
    }
    steps.push(step);
    cycle = handoff.requireCycle(cycleId);

    // Fail-fast: any REJECTED external dispatch ends the canary run.
    const rejected = findRejectedDispatchesViaStore(handoff, cycleId);
    for (const d of rejected) {
      if (seenRejected.has(d.dispatch_id)) continue;
      seenRejected.add(d.dispatch_id);
      const evidence = toExternalRejectionEvidence(d);
      return {
        cycle,
        steps,
        status: B2_S2_CANARY_EXTERNAL_RESULT_REJECTED,
        externalRejection: evidence,
        initialPcPolicy,
        detail: evidence.detail,
      };
    }

    if (FAIL_FAST_STEP_ACTIONS.has(step.action)) {
      const latestRejected =
        rejected[rejected.length - 1] ??
        findLatestDispatch(handoff, cycleId);
      const evidence = latestRejected
        ? toExternalRejectionEvidence(latestRejected)
        : {
            role: "unknown",
            request_id: cycle.current_request_id ?? "unknown",
            dispatch_id: "unknown",
            attempt_number: 1,
            failure_class: step.action,
            detail:
              typeof step.detail?.message === "string"
                ? step.detail.message
                : typeof step.detail?.reason === "string"
                  ? step.detail.reason
                  : step.action,
          };
      return {
        cycle,
        steps,
        status: B2_S2_CANARY_EXTERNAL_RESULT_REJECTED,
        externalRejection: evidence,
        initialPcPolicy,
        detail: evidence.detail,
      };
    }

    // After first accepted PC decision, enforce canary-local BUILD policy.
    if (!initialPcValidated) {
      const decisions = acceptedPcDecisions(handoff, cycleId);
      if (decisions.length >= 1) {
        const first = decisions[0]!;
        const policy = first.install_policy?.on_builder_candidate;
        initialPcPolicy =
          policy === "DISPATCH_REVIEW"
            ? "DISPATCH_REVIEW"
            : policy === "AWAIT_PC"
              ? "AWAIT_PC"
              : "OTHER";
        try {
          assertInitialCanaryBuildPolicy(first);
          initialPcValidated = true;
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          return {
            cycle,
            steps,
            status: B2_S2_CANARY_INITIAL_PC_CONTRACT_VIOLATION,
            externalRejection: null,
            initialPcPolicy,
            detail: message,
          };
        }
      }
    }

    if (
      cycle.state === "ACCEPTED" ||
      cycle.state === "ABORTED" ||
      cycle.state === "HUMAN_GATE"
    ) {
      return {
        cycle,
        steps,
        status: classifyTerminal(cycle),
        externalRejection: null,
        initialPcPolicy,
        detail: null,
      };
    }
  }

  return {
    cycle: handoff.requireCycle(cycleId),
    steps,
    status: "MAX_STEPS",
    externalRejection: null,
    initialPcPolicy,
    detail: `exceeded maxSteps=${maxSteps}`,
  };
}

function findLatestDispatch(
  handoff: HandoffStore,
  cycleId: string,
): DispatchRecord | null {
  const rows = handoff.store.db
    .prepare(
      `SELECT * FROM dispatches WHERE cycle_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .all(cycleId) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
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
    binding_id: row.binding_id == null ? null : String(row.binding_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
