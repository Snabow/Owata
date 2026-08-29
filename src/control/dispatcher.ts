import { ControlError } from "./types.js";
import { nowIso } from "./ids.js";
import type {
  BuilderAdapter,
  ProgramControlAdapter,
  ReviewerAdapter,
} from "./adapters.js";
import {
  HandoffStore,
  type CycleRecord,
  type DispatchRecord,
} from "./handoff.js";
import {
  parseCanonicalEnvelope,
  PROTOCOL_V1,
  type BuilderResultBody,
  type CanonicalEnvelope,
  type ControlRequestBody,
  type CycleState,
  type FailureClass,
  type LogicalRole,
  type PcDecisionBody,
  type PcDecisionKind,
  type ReviewerResultBody,
} from "./protocol.js";

export interface DispatcherAdapters {
  programControl: ProgramControlAdapter;
  builder: BuilderAdapter;
  reviewer: ReviewerAdapter;
}

export interface DispatcherOptions {
  owner: string;
  leaseMs: number;
}

export interface StepResult {
  cycle: CycleRecord;
  action: string;
  detail?: Record<string, unknown>;
}

const DEFAULT_BUILD_CAPS = [
  "repository_read",
  "repository_write",
  "exact_checkout",
  "command_execution",
] as const;

const DEFAULT_REVIEW_CAPS = [
  "repository_read",
  "exact_checkout",
  "command_execution",
] as const;

export class Dispatcher {
  constructor(
    readonly handoff: HandoffStore,
    readonly adapters: DispatcherAdapters,
    readonly options: DispatcherOptions,
  ) {}

  recover(now?: Date): number {
    return this.handoff.recoverExpiredDispatches(now ?? this.handoff.store.now());
  }

  step(cycleId: string): StepResult {
    this.recover();
    const cycle = this.handoff.requireCycle(cycleId);
    switch (cycle.state) {
      case "AWAITING_PC":
      case "RECOVERY_REQUIRED":
        return this.invokeProgramControl(cycle);
      case "DISPATCHING_BUILD":
        return this.invokeRole(cycle, "builder");
      case "DISPATCHING_REVIEW":
        return this.invokeRole(cycle, "reviewer");
      case "HUMAN_GATE":
        return this.applyHumanGateIfAnswered(cycle);
      case "ACCEPTED":
      case "ABORTED":
        return { cycle, action: "idle" };
    }
  }

  runUntilStable(cycleId: string, maxSteps = 32): StepResult {
    let last: StepResult = {
      cycle: this.handoff.requireCycle(cycleId),
      action: "start",
    };
    for (let i = 0; i < maxSteps; i += 1) {
      last = this.step(cycleId);
      const state = last.cycle.state;
      if (
        state === "ACCEPTED" ||
        state === "ABORTED" ||
        state === "HUMAN_GATE" ||
        state === "RECOVERY_REQUIRED" ||
        state === "AWAITING_PC" ||
        last.action === "idle"
      ) {
        return last;
      }
    }
    throw new ControlError("DISPATCH_LOOP", `Cycle ${cycleId} did not stabilize`);
  }

  claimCurrent(cycleId: string): DispatchRecord {
    const cycle = this.handoff.requireCycle(cycleId);
    const request = this.requireCurrentRequest(cycle);
    return this.handoff.claimDispatch({
      cycleId,
      requestId: request.request_id!,
      targetRole: request.body.target_role,
      owner: this.options.owner,
      leaseMs: this.options.leaseMs,
    });
  }

  private invokeProgramControl(cycle: CycleRecord): StepResult {
    const envelopes = this.handoff.listEnvelopes(cycle.cycle_id);
    const raw = this.adapters.programControl.decide({
      cycle: this.handoff.snapshot(cycle),
      envelopes,
    });
    let parsed;
    try {
      parsed = parseCanonicalEnvelope(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ControlError("RESULT_INVALID", `Program Control result invalid: ${message}`);
    }
    if (parsed.kind !== "program_control_decision") {
      throw new ControlError("RESULT_INVALID", "Program Control must return a Decision");
    }
    if (parsed.cycle_id !== cycle.cycle_id) {
      throw new ControlError("RESULT_INVALID", "Decision cycle_id mismatch");
    }
    const decision = this.handoff.store.runImmediate(() => {
      const env = this.handoff.persistEnvelope(parsed);
      this.handoff.store.appendEvent("cycle.decision_persisted", {
        project_id: cycle.project_id,
        work_id: null,
        payload: {
          cycle_id: cycle.cycle_id,
          envelope_id: env.envelope_id,
          decision: (env.body as PcDecisionBody).decision,
        },
      });
      return this.applyDecision(cycle, env as CanonicalEnvelope<PcDecisionBody>);
    });
    return { cycle: decision, action: "pc_decision" };
  }

  private applyDecision(
    cycle: CycleRecord,
    env: CanonicalEnvelope<PcDecisionBody>,
  ): CycleRecord {
    const body = env.body;
    switch (body.decision) {
      case "BUILD":
        return this.persistRoleRequest(cycle, env, "BUILD", "builder");
      case "REWORK":
        return this.persistRoleRequest(cycle, env, "REWORK", "builder");
      case "ACCEPT":
        return this.handoff.transition(cycle.cycle_id, "ACCEPTED", {
          accepted_candidate_sha: cycle.latest_candidate_sha,
          recovery_reason: null,
        });
      case "RETRY":
        if (!cycle.current_request_id) {
          throw new ControlError("PROTOCOL", "RETRY requires a current request");
        }
        return this.handoff.transition(
          cycle.cycle_id,
          this.stateForCurrentRequest(cycle),
          { recovery_reason: null },
        );
      case "REDESIGN":
        return this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
          recovery_reason: "REDESIGN",
          current_request_id: null,
        });
      case "HUMAN_GATE":
        this.handoff.createHumanGate({
          cycleId: cycle.cycle_id,
          decisionEnvelopeId: env.envelope_id,
          purpose: body.human_gate_purpose ?? "Human gate",
          allowedChoices: body.human_gate_choices ?? ["ACCEPT", "ABORT"],
        });
        return this.handoff.transition(cycle.cycle_id, "HUMAN_GATE");
      case "ABORT":
        return this.handoff.transition(cycle.cycle_id, "ABORTED", {
          recovery_reason: "ABORT",
        });
    }
  }

  private persistRoleRequest(
    cycle: CycleRecord,
    decision: CanonicalEnvelope<PcDecisionBody>,
    action: "BUILD" | "REWORK",
    target: LogicalRole,
  ): CycleRecord {
    const ts = nowIso(() => this.handoff.store.now());
    const requestId = this.handoff.store.nextId("req");
    const body: ControlRequestBody = {
      action,
      target_role: target,
      work_package_ref: cycle.work_package_ref,
      base_sha: cycle.base_sha,
      target_sha: action === "REWORK" ? cycle.latest_candidate_sha : cycle.base_sha,
      authoritative_references: [
        `work-packages/${cycle.work_package_ref}`,
        "decisions/DEC-003-001-wp003-architecture.md",
      ],
      required_capabilities: [...DEFAULT_BUILD_CAPS],
      expected_result_kind: "builder_result",
      stop_condition: "bounded fake adapter; no real provider",
      authorized_by_decision_id: decision.envelope_id,
      authorized_finding_ids: decision.body.authorized_finding_ids,
    };
    this.handoff.persistEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: this.handoff.store.nextId("env"),
      kind: "control_request",
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      from_role: "program_control",
      to_role: target,
      created_at: ts,
      body,
    });
    this.handoff.store.appendEvent("cycle.request_persisted", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: cycle.cycle_id,
        request_id: requestId,
        action,
        authorized_by_decision_id: decision.envelope_id,
        authorized_finding_ids: body.authorized_finding_ids,
      },
    });
    return this.handoff.transition(cycle.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: requestId,
      recovery_reason: null,
    });
  }

  private persistReviewRequest(cycle: CycleRecord, targetSha: string): CycleRecord {
    const ts = nowIso(() => this.handoff.store.now());
    const requestId = this.handoff.store.nextId("req");
    const body: ControlRequestBody = {
      action: "REVIEW",
      target_role: "reviewer",
      work_package_ref: cycle.work_package_ref,
      base_sha: cycle.base_sha,
      target_sha: targetSha,
      authoritative_references: [
        `work-packages/${cycle.work_package_ref}`,
        "decisions/DEC-003-001-wp003-architecture.md",
      ],
      required_capabilities: [...DEFAULT_REVIEW_CAPS],
      expected_result_kind: "reviewer_result",
      stop_condition: "exact target_sha required; no Builder chat",
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
    };
    this.handoff.persistEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: this.handoff.store.nextId("env"),
      kind: "control_request",
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      from_role: "dispatcher",
      to_role: "reviewer",
      created_at: ts,
      body,
    });
    this.handoff.store.appendEvent("cycle.request_persisted", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: cycle.cycle_id,
        request_id: requestId,
        action: "REVIEW",
        target_sha: targetSha,
        authorized_by_policy: cycle.policy.on_builder_candidate,
      },
    });
    return this.handoff.transition(cycle.cycle_id, "DISPATCHING_REVIEW", {
      current_request_id: requestId,
      latest_candidate_sha: targetSha,
    });
  }

  private requireCurrentRequest(
    cycle: CycleRecord,
  ): CanonicalEnvelope<ControlRequestBody> {
    if (!cycle.current_request_id) {
      throw new ControlError("PROTOCOL", "Cycle has no current request");
    }
    const found = this.handoff
      .listEnvelopes(cycle.cycle_id)
      .find(
        (e) =>
          e.kind === "control_request" && e.request_id === cycle.current_request_id,
      );
    if (!found) {
      throw new ControlError("PROTOCOL", "Current request envelope missing");
    }
    return found as CanonicalEnvelope<ControlRequestBody>;
  }

  private stateForCurrentRequest(cycle: CycleRecord): CycleState {
    if (!cycle.current_request_id) return "AWAITING_PC";
    const req = this.requireCurrentRequest(cycle);
    return req.body.action === "REVIEW" ? "DISPATCHING_REVIEW" : "DISPATCHING_BUILD";
  }

  private invokeRole(cycle: CycleRecord, role: "builder" | "reviewer"): StepResult {
    const request = this.requireCurrentRequest(cycle);
    const accepted = this.handoff.acceptedDispatch(cycle.cycle_id, request.request_id!);
    if (accepted) {
      return { cycle, action: "already_accepted" };
    }

    const required = request.body.required_capabilities;
    const adapter = role === "builder" ? this.adapters.builder : this.adapters.reviewer;
    const pre = adapter.preflight(required);
    if (!pre.ok) {
      this.handoff.recordCapabilityBlock({
        cycleId: cycle.cycle_id,
        requestId: request.request_id!,
        missing: pre.missing,
      });
      return {
        cycle: this.handoff.requireCycle(cycle.cycle_id),
        action: "capability_block",
        detail: { missing: pre.missing },
      };
    }

    let dispatch: DispatchRecord;
    try {
      const existing = this.handoff.latestDispatch(cycle.cycle_id, request.request_id!);
      const leaseValid =
        existing != null &&
        existing.state === "CLAIMED" &&
        existing.owner === this.options.owner &&
        this.handoff.store.now().getTime() < Date.parse(existing.lease_expires_at);
      dispatch = leaseValid && existing
        ? existing
        : this.handoff.claimDispatch({
            cycleId: cycle.cycle_id,
            requestId: request.request_id!,
            targetRole: request.body.target_role,
            owner: this.options.owner,
            leaseMs: this.options.leaseMs,
          });
    } catch (err) {
      if (err instanceof ControlError && err.code === "RETRY_BUDGET") {
        return {
          cycle: this.handoff.requireCycle(cycle.cycle_id),
          action: "retry_budget",
        };
      }
      throw err;
    }

    const input = {
      cycle: this.handoff.snapshot(cycle),
      request,
    };
    let raw: unknown;
    try {
      raw = role === "builder" ? this.adapters.builder.build(input) : this.adapters.reviewer.review(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handoff.rejectResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        failureClass: "RUNTIME_ERROR",
        detail: message,
      });
      return {
        cycle: this.handoff.requireCycle(cycle.cycle_id),
        action: "runtime_error",
        detail: { message },
      };
    }

    return this.acceptRoleOutput(cycle, request, dispatch, raw, role);
  }

  private acceptRoleOutput(
    cycle: CycleRecord,
    request: CanonicalEnvelope<ControlRequestBody>,
    dispatch: DispatchRecord,
    raw: unknown,
    role: "builder" | "reviewer",
  ): StepResult {
    let parsed: CanonicalEnvelope;
    try {
      parsed = parseCanonicalEnvelope(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handoff.rejectResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        failureClass: "RESULT_INVALID",
        detail: message,
      });
      return {
        cycle: this.handoff.requireCycle(cycle.cycle_id),
        action: "result_invalid",
      };
    }

    if (parsed.request_id !== request.request_id) {
      this.handoff.rejectResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        failureClass: "RESULT_STALE",
        detail: "request_id mismatch",
      });
      return { cycle: this.handoff.requireCycle(cycle.cycle_id), action: "result_stale" };
    }
    if (parsed.cycle_id !== cycle.cycle_id) {
      this.handoff.rejectResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        failureClass: "RESULT_STALE",
        detail: "cycle_id mismatch",
      });
      return { cycle: this.handoff.requireCycle(cycle.cycle_id), action: "result_stale" };
    }

    if (role === "reviewer") {
      if (parsed.kind !== "reviewer_result") {
        this.handoff.rejectResult({
          dispatchId: dispatch.dispatch_id,
          fenceToken: dispatch.fence_token,
          failureClass: "RESULT_INVALID",
          detail: "expected reviewer_result",
        });
        return { cycle: this.handoff.requireCycle(cycle.cycle_id), action: "result_invalid" };
      }
      const body = parsed.body as ReviewerResultBody;
      if (request.body.target_sha && body.target_sha !== request.body.target_sha) {
        this.handoff.rejectResult({
          dispatchId: dispatch.dispatch_id,
          fenceToken: dispatch.fence_token,
          failureClass: "RESULT_STALE",
          detail: `review target ${body.target_sha} != ${request.body.target_sha}`,
        });
        return { cycle: this.handoff.requireCycle(cycle.cycle_id), action: "result_stale" };
      }
      this.handoff.store.runImmediate(() => {
        this.handoff.acceptResult({
          dispatchId: dispatch.dispatch_id,
          fenceToken: dispatch.fence_token,
          envelope: parsed,
        });
        // Findings are persisted as-is. Dispatcher does not interpret them.
        this.handoff.transition(cycle.cycle_id, "AWAITING_PC");
      });
      return {
        cycle: this.handoff.requireCycle(cycle.cycle_id),
        action: "reviewer_result",
        detail: { verdict: body.verdict },
      };
    }

    if (parsed.kind !== "builder_result") {
      this.handoff.rejectResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        failureClass: "RESULT_INVALID",
        detail: "expected builder_result",
      });
      return { cycle: this.handoff.requireCycle(cycle.cycle_id), action: "result_invalid" };
    }
    const body = parsed.body as BuilderResultBody;
    this.handoff.store.runImmediate(() => {
      this.handoff.acceptResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        envelope: parsed,
      });
      if (body.status === "CANDIDATE_READY" && body.candidate_sha) {
        if (cycle.policy.on_builder_candidate === "DISPATCH_REVIEW") {
          this.persistReviewRequest(
            {
              ...this.handoff.requireCycle(cycle.cycle_id),
              latest_candidate_sha: body.candidate_sha,
            },
            body.candidate_sha,
          );
        } else {
          this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
            latest_candidate_sha: body.candidate_sha,
          });
        }
      } else {
        this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
          recovery_reason: body.status,
        });
      }
    });
    return {
      cycle: this.handoff.requireCycle(cycle.cycle_id),
      action: "builder_result",
      detail: { status: body.status, candidate_sha: body.candidate_sha },
    };
  }

  private applyHumanGateIfAnswered(cycle: CycleRecord): StepResult {
    const gate = this.handoff.openGateForCycle(cycle.cycle_id);
    if (gate) {
      return { cycle, action: "await_human_gate" };
    }
    const answered = this.handoff.store.db
      .prepare(
        `SELECT * FROM human_gates WHERE cycle_id = ? AND state = 'ANSWERED'
         ORDER BY updated_at DESC`,
      )
      .get(cycle.cycle_id) as { selected_choice: string } | undefined;
    if (!answered) {
      return { cycle, action: "await_human_gate" };
    }
    const choice = answered.selected_choice as PcDecisionKind;
    const next = this.handoff.store.runImmediate(() => {
      if (choice === "ACCEPT") {
        return this.handoff.transition(cycle.cycle_id, "ACCEPTED", {
          accepted_candidate_sha: cycle.latest_candidate_sha,
          recovery_reason: null,
        });
      }
      if (choice === "ABORT") {
        return this.handoff.transition(cycle.cycle_id, "ABORTED", {
          recovery_reason: "ABORT",
        });
      }
      if (choice === "RETRY") {
        return this.handoff.transition(
          cycle.cycle_id,
          this.stateForCurrentRequest(cycle),
          { recovery_reason: null },
        );
      }
      return this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
        recovery_reason: choice,
      });
    });
    return { cycle: next, action: "human_gate_applied", detail: { choice } };
  }
}

export function classifyFailure(code: string): FailureClass {
  if (code === "RESULT_INVALID") return "RESULT_INVALID";
  if (code === "RESULT_STALE" || code === "STALE_FENCE") return "RESULT_STALE";
  if (code === "CAPABILITY_BLOCK") return "CAPABILITY_BLOCK";
  return "RUNTIME_ERROR";
}
