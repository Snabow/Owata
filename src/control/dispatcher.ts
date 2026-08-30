import { ControlError } from "./types.js";
import { nowIso } from "./ids.js";
import type {
  BuilderAdapter,
  CycleSnapshot,
  ProgramControlAdapter,
  ReviewerAdapter,
  RoleAdapter,
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
import { assertPcDecisionAuthority } from "../program-control/authority.js";

export interface DispatcherAdapters {
  programControl: ProgramControlAdapter;
  builder: BuilderAdapter;
  reviewer: ReviewerAdapter;
}

/**
 * Context handed to the injectable Git reality verifier before a Builder
 * CANDIDATE_READY result may be accepted. Fake-adapter tests may leave the hook
 * unset; adapter_id "fake-builder" is the only exemption. Every other Builder
 * adapter requires a verifier (fail-closed when missing).
 */
export interface GitRealityContext {
  cycle: CycleSnapshot;
  request: CanonicalEnvelope<ControlRequestBody>;
  dispatch: DispatchRecord;
  candidate_sha: string;
  adapter_id: string;
}

export interface DispatcherOptions {
  owner: string;
  leaseMs: number;
  /** When > 0, renew the dispatch lease at this interval while an async adapter runs. */
  heartbeatMs?: number;
  /** Injectable Git reality verifier for Builder CANDIDATE_READY results. */
  gitReality?: (ctx: GitRealityContext) => void | Promise<void>;
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

const DEFAULT_PC_CAPS = ["repository_read"] as const;

type DispatchRole = "program_control" | "builder" | "reviewer";

export class Dispatcher {
  constructor(
    readonly handoff: HandoffStore,
    readonly adapters: DispatcherAdapters,
    readonly options: DispatcherOptions,
  ) {}

  recover(now?: Date): number {
    return this.handoff.recoverExpiredDispatches(now ?? this.handoff.store.now());
  }

  async step(cycleId: string): Promise<StepResult> {
    this.recover();
    let cycle = this.handoff.requireCycle(cycleId);
    switch (cycle.state) {
      case "AWAITING_PC":
      case "RECOVERY_REQUIRED":
        cycle = this.ensureProgramControlRequest(cycle);
        if (cycle.state !== "DISPATCHING_PC") {
          return { cycle, action: "await_pc_setup" };
        }
        return this.invokeRole(cycle, "program_control");
      case "DISPATCHING_PC":
        return this.invokeRole(cycle, "program_control");
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

  async runUntilStable(cycleId: string, maxSteps = 48): Promise<StepResult> {
    let last: StepResult = {
      cycle: this.handoff.requireCycle(cycleId),
      action: "start",
    };
    for (let i = 0; i < maxSteps; i += 1) {
      last = await this.step(cycleId);
      const state = last.cycle.state;
      if (
        state === "ACCEPTED" ||
        state === "ABORTED" ||
        state === "HUMAN_GATE" ||
        state === "RECOVERY_REQUIRED" ||
        last.action === "idle" ||
        last.action === "capability_block" ||
        last.action === "retry_budget"
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

  private ensureProgramControlRequest(cycle: CycleRecord): CycleRecord {
    if (
      cycle.state === "RECOVERY_REQUIRED" &&
      !cycle.recovery_lineage_id &&
      cycle.current_request_id
    ) {
      const maybe = this.handoff
        .listEnvelopes(cycle.cycle_id)
        .find(
          (e) =>
            e.kind === "control_request" &&
            e.request_id === cycle.current_request_id,
        ) as CanonicalEnvelope<ControlRequestBody> | undefined;
      if (
        maybe &&
        (maybe.body.target_role === "builder" ||
          maybe.body.target_role === "reviewer")
      ) {
        cycle = this.handoff.enterRecovery({
          cycleId: cycle.cycle_id,
          requestId: maybe.request_id!,
          reason: cycle.recovery_reason ?? "recovery_target_backfill",
        });
      }
    }

    if (cycle.current_request_id) {
      const existing = this.handoff
        .listEnvelopes(cycle.cycle_id)
        .find(
          (e) =>
            e.kind === "control_request" &&
            e.request_id === cycle.current_request_id,
        ) as CanonicalEnvelope<ControlRequestBody> | undefined;
      if (
        existing &&
        existing.body.target_role === "program_control" &&
        (existing.body.action === "DECIDE" || existing.body.action === "ADJUDICATE")
      ) {
        if (!this.handoff.acceptedDispatch(cycle.cycle_id, existing.request_id!)) {
          if (cycle.state !== "DISPATCHING_PC") {
            return this.handoff.transition(cycle.cycle_id, "DISPATCHING_PC");
          }
          return cycle;
        }
      }
    }

    const ts = nowIso(() => this.handoff.store.now());
    const requestId = this.handoff.store.nextId("req");
    const action =
      cycle.state === "RECOVERY_REQUIRED" ? "ADJUDICATE" : "DECIDE";
    const body: ControlRequestBody = {
      action,
      target_role: "program_control",
      work_package_ref: cycle.work_package_ref,
      base_sha: cycle.base_sha,
      target_sha: cycle.latest_candidate_sha,
      authoritative_references: [
        `work-packages/${cycle.work_package_ref}`,
        "decisions/DEC-003-001-wp003-architecture.md",
      ],
      required_capabilities: [...DEFAULT_PC_CAPS],
      expected_result_kind: "program_control_decision",
      stop_condition:
        this.adapters.programControl.identity.adapter_id ===
        "gateway-program-control"
          ? "real Program Control; durable envelopes; no Browser Relay"
          : "bounded fake PC; no real provider",
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
      retry_of_request_id: null,
    };
    return this.handoff.store.runImmediate(() => {
      this.handoff.persistEnvelope({
        protocol: PROTOCOL_V1,
        envelope_id: this.handoff.store.nextId("env"),
        kind: "control_request",
        cycle_id: cycle.cycle_id,
        request_id: requestId,
        from_role: "dispatcher",
        to_role: "program_control",
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
          target_role: "program_control",
          recovery_target_request_id: cycle.recovery_target_request_id,
        },
      });
      // Do not erase recovery_target_request_id when creating the PC ADJUDICATE request.
      return this.handoff.transition(cycle.cycle_id, "DISPATCHING_PC", {
        current_request_id: requestId,
      });
    });
  }

  private adapterFor(role: DispatchRole): RoleAdapter {
    if (role === "program_control") return this.adapters.programControl;
    if (role === "builder") return this.adapters.builder;
    return this.adapters.reviewer;
  }

  private async invokeRole(
    cycle: CycleRecord,
    role: DispatchRole,
  ): Promise<StepResult> {
    const request = this.requireCurrentRequest(cycle);
    if (request.body.target_role !== role) {
      throw new ControlError(
        "PROTOCOL",
        `Current request targets ${request.body.target_role}, not ${role}`,
      );
    }

    const accepted = this.handoff.acceptedDispatch(cycle.cycle_id, request.request_id!);
    if (accepted) {
      return { cycle, action: "already_accepted" };
    }

    const adapter = this.adapterFor(role);
    if (adapter.identity.role !== role) {
      const recoveryTarget =
        role === "builder" || role === "reviewer" ? request.request_id! : null;
      this.handoff.enterRecovery({
        cycleId: cycle.cycle_id,
        requestId: recoveryTarget,
        reason: "ADAPTER_ROLE_MISMATCH",
        evidenceEventType: "cycle.result_rejected",
        evidencePayload: {
          failure_class: "RESULT_INVALID",
          detail: `adapter identity.role ${adapter.identity.role} != ${role}`,
        },
      });
      return {
        cycle: this.handoff.requireCycle(cycle.cycle_id),
        action: "adapter_role_mismatch",
        detail: { configured: adapter.identity.role, expected: role },
      };
    }

    const required = request.body.required_capabilities;
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
      dispatch =
        leaseValid && existing
          ? existing
          : this.handoff.claimDispatch({
              cycleId: cycle.cycle_id,
              requestId: request.request_id!,
              targetRole: role,
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

    const abort = new AbortController();
    const stopHeartbeat = this.startLeaseHeartbeat(dispatch, abort);
    let raw: unknown;
    try {
      if (role === "program_control") {
        raw = await this.adapters.programControl.decide({
          cycle: this.handoff.snapshot(cycle),
          envelopes: this.handoff.listEnvelopes(cycle.cycle_id),
          request,
          dispatch: {
            dispatch_id: dispatch.dispatch_id,
            attempt_number: dispatch.attempt_number,
            fence_token: dispatch.fence_token,
            lease_expires_at: dispatch.lease_expires_at,
          },
          signal: abort.signal,
        });
      } else if (role === "builder") {
        raw = await this.adapters.builder.build({
          cycle: this.handoff.snapshot(cycle),
          request,
          envelopes: this.handoff.listEnvelopes(cycle.cycle_id),
          dispatch: {
            dispatch_id: dispatch.dispatch_id,
            attempt_number: dispatch.attempt_number,
            fence_token: dispatch.fence_token,
            lease_expires_at: dispatch.lease_expires_at,
          },
          signal: abort.signal,
        });
      } else {
        raw = await this.adapters.reviewer.review({
          cycle: this.handoff.snapshot(cycle),
          request,
          dispatch: {
            dispatch_id: dispatch.dispatch_id,
            attempt_number: dispatch.attempt_number,
            fence_token: dispatch.fence_token,
            lease_expires_at: dispatch.lease_expires_at,
          },
          signal: abort.signal,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let failureClass: FailureClass = "RUNTIME_ERROR";
      if (err instanceof ControlError) {
        failureClass = classifyFailure(err.code);
      } else if (abort.signal.aborted) {
        const reason = abort.signal.reason;
        if (reason instanceof ControlError) {
          failureClass = classifyFailure(reason.code);
        } else {
          failureClass = "RESULT_STALE";
        }
      }
      try {
        this.handoff.rejectResult({
          dispatchId: dispatch.dispatch_id,
          fenceToken: dispatch.fence_token,
          failureClass,
          detail: message,
        });
      } catch {
        // fence may already be non-CLAIMED after expiry/recovery
      }
      return {
        cycle: this.handoff.requireCycle(cycle.cycle_id),
        action: failureClass === "RESULT_STALE" ? "result_stale" : "runtime_error",
        detail: { message },
      };
    } finally {
      stopHeartbeat();
    }

    return this.acceptRoleOutput(cycle, request, dispatch, raw, role);
  }

  /**
   * Renew the same claimed fence while a long adapter invocation runs.
   * Heartbeat failure aborts the adapter via AbortSignal; it does not
   * invent workflow authority — SQLite fencing still decides acceptance.
   */
  private startLeaseHeartbeat(
    dispatch: DispatchRecord,
    abort: AbortController,
  ): () => void {
    const ms = this.options.heartbeatMs ?? 0;
    if (!(ms > 0)) {
      return () => undefined;
    }
    const timer = setInterval(() => {
      try {
        const live = this.handoff.renewDispatchLease(
          dispatch.dispatch_id,
          dispatch.fence_token,
          this.options.leaseMs,
        );
        dispatch.lease_expires_at = live.lease_expires_at;
      } catch (err) {
        const reason =
          err instanceof ControlError
            ? err
            : new ControlError(
                "STALE_FENCE",
                err instanceof Error ? err.message : String(err),
              );
        abort.abort(reason);
        clearInterval(timer);
      }
    }, ms);
    // Allow Node to exit if only the heartbeat remains (tests / short runs).
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private expectAuthority(
    role: DispatchRole,
    request: CanonicalEnvelope<ControlRequestBody>,
    parsed: CanonicalEnvelope,
  ): string | null {
    if (parsed.request_id !== request.request_id) return "request_id mismatch";
    if (parsed.cycle_id !== request.cycle_id) return "cycle_id mismatch";
    if (request.to_role !== role) {
      return "request.to_role mismatch";
    }
    if (role === "program_control") {
      if (parsed.kind !== "program_control_decision") return "expected program_control_decision";
      if (parsed.from_role !== "program_control") return "from_role must be program_control";
      return null;
    }
    if (role === "builder") {
      if (parsed.kind !== "builder_result") return "expected builder_result";
      if (parsed.from_role !== "builder") return "from_role must be builder";
      if (request.body.target_role !== "builder") return "request target_role must be builder";
      return null;
    }
    if (parsed.kind !== "reviewer_result") return "expected reviewer_result";
    if (parsed.from_role !== "reviewer") return "from_role must be reviewer";
    if (request.body.target_role !== "reviewer") return "request target_role must be reviewer";
    return null;
  }

  private async acceptRoleOutput(
    cycle: CycleRecord,
    request: CanonicalEnvelope<ControlRequestBody>,
    dispatch: DispatchRecord,
    raw: unknown,
    role: DispatchRole,
  ): Promise<StepResult> {
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

    const authorityError = this.expectAuthority(role, request, parsed);
    if (authorityError) {
      const failureClass: FailureClass =
        authorityError.includes("mismatch") && !authorityError.includes("from_role")
          ? "RESULT_STALE"
          : "RESULT_INVALID";
      this.handoff.rejectResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        failureClass,
        detail: authorityError,
      });
      return {
        cycle: this.handoff.requireCycle(cycle.cycle_id),
        action: failureClass === "RESULT_STALE" ? "result_stale" : "result_invalid",
        detail: { reason: authorityError },
      };
    }

    if (role === "program_control") {
      return this.acceptProgramControl(cycle, dispatch, parsed);
    }
    if (role === "reviewer") {
      return this.acceptReviewer(cycle, request, dispatch, parsed);
    }
    return this.acceptBuilder(cycle, request, dispatch, parsed);
  }

  private acceptProgramControl(
    cycle: CycleRecord,
    dispatch: DispatchRecord,
    parsed: CanonicalEnvelope,
  ): StepResult {
    const body = parsed.body as PcDecisionBody;
    try {
      const next = this.handoff.store.runImmediate(() => {
        const live = this.handoff.requireCycle(cycle.cycle_id);
        if (live.state !== "DISPATCHING_PC") {
          throw new ControlError(
            "STALE_FENCE",
            `Cycle left DISPATCHING_PC (now ${live.state}); refusing Decision`,
          );
        }
        this.handoff.acceptResult({
          dispatchId: dispatch.dispatch_id,
          fenceToken: dispatch.fence_token,
          envelope: parsed,
        });
        this.handoff.store.appendEvent("cycle.decision_persisted", {
          project_id: live.project_id,
          work_id: null,
          payload: {
            cycle_id: live.cycle_id,
            envelope_id: parsed.envelope_id,
            decision: body.decision,
            dispatch_id: dispatch.dispatch_id,
          },
        });
        // Deterministic authority gates before applying ACCEPT / REWORK.
        assertPcDecisionAuthority({
          decision: body,
          cycle: this.handoff.snapshot(live),
          envelopes: this.handoff.listEnvelopes(live.cycle_id),
        });
        return this.applyDecision(live, parsed as CanonicalEnvelope<PcDecisionBody>);
      });
      return { cycle: next, action: "pc_decision", detail: { decision: body.decision } };
    } catch (err) {
      if (err instanceof ControlError && err.code === "STALE_FENCE") {
        try {
          this.handoff.rejectResult({
            dispatchId: dispatch.dispatch_id,
            fenceToken: dispatch.fence_token,
            failureClass: "RESULT_STALE",
            detail: err.message,
          });
        } catch {
          // fence may already be non-CLAIMED
        }
        return {
          cycle: this.handoff.requireCycle(cycle.cycle_id),
          action: "result_stale",
          detail: { reason: err.message },
        };
      }
      if (
        err instanceof ControlError &&
        (err.code === "POLICY_PROVENANCE" ||
          err.code === "PROTOCOL" ||
          err.code === "RESULT_INVALID")
      ) {
        try {
          this.handoff.rejectResult({
            dispatchId: dispatch.dispatch_id,
            fenceToken: dispatch.fence_token,
            failureClass: "RESULT_INVALID",
            detail: err.message,
          });
        } catch {
          // fence may already be non-CLAIMED
        }
        return {
          cycle: this.handoff.requireCycle(cycle.cycle_id),
          action: "result_invalid",
          detail: { reason: err.message, code: err.code },
        };
      }
      throw err;
    }
  }

  private acceptReviewer(
    cycle: CycleRecord,
    request: CanonicalEnvelope<ControlRequestBody>,
    dispatch: DispatchRecord,
    parsed: CanonicalEnvelope,
  ): StepResult {
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
      this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
        current_request_id: null,
      });
    });
    return {
      cycle: this.handoff.requireCycle(cycle.cycle_id),
      action: "reviewer_result",
      detail: { verdict: body.verdict },
    };
  }

  private async acceptBuilder(
    cycle: CycleRecord,
    request: CanonicalEnvelope<ControlRequestBody>,
    dispatch: DispatchRecord,
    parsed: CanonicalEnvelope,
  ): Promise<StepResult> {
    const body = parsed.body as BuilderResultBody;
    if (body.status === "CANDIDATE_READY" && body.candidate_sha) {
      const adapterId = this.adapters.builder.identity.adapter_id;
      if (adapterId !== "fake-builder") {
        if (!this.options.gitReality) {
          const reason =
            "git reality verifier not configured for non-fake builder";
          this.handoff.rejectResult({
            dispatchId: dispatch.dispatch_id,
            fenceToken: dispatch.fence_token,
            failureClass: "RESULT_INVALID",
            detail: `git reality: ${reason}`,
          });
          return {
            cycle: this.handoff.requireCycle(cycle.cycle_id),
            action: "result_invalid",
            detail: { reason },
          };
        }
        try {
          await this.options.gitReality({
            cycle: this.handoff.snapshot(cycle),
            request,
            dispatch,
            candidate_sha: body.candidate_sha,
            adapter_id: adapterId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.handoff.rejectResult({
            dispatchId: dispatch.dispatch_id,
            fenceToken: dispatch.fence_token,
            failureClass: "RESULT_INVALID",
            detail: `git reality: ${message}`,
          });
          return {
            cycle: this.handoff.requireCycle(cycle.cycle_id),
            action: "result_invalid",
            detail: { reason: message },
          };
        }
      }
    }
    this.handoff.store.runImmediate(() => {
      this.handoff.acceptResult({
        dispatchId: dispatch.dispatch_id,
        fenceToken: dispatch.fence_token,
        envelope: parsed,
      });
      if (body.status === "CANDIDATE_READY" && body.candidate_sha) {
        const live = this.handoff.requireCycle(cycle.cycle_id);
        if (this.handoff.mayAutoDispatchReview(live)) {
          this.persistReviewRequest(
            { ...live, latest_candidate_sha: body.candidate_sha },
            body.candidate_sha,
          );
        } else {
          this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
            latest_candidate_sha: body.candidate_sha,
            current_request_id: null,
          });
        }
      } else {
        this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
          recovery_reason: body.status,
          current_request_id: null,
        });
      }
    });
    return {
      cycle: this.handoff.requireCycle(cycle.cycle_id),
      action: "builder_result",
      detail: { status: body.status, candidate_sha: body.candidate_sha },
    };
  }

  private applyDecision(
    cycle: CycleRecord,
    env: CanonicalEnvelope<PcDecisionBody>,
  ): CycleRecord {
    const body = env.body;
    if (body.install_policy) {
      this.handoff.installPolicyFromDecision(cycle.cycle_id, env.envelope_id, {
        on_builder_candidate: body.install_policy.on_builder_candidate,
      });
      cycle = this.handoff.requireCycle(cycle.cycle_id);
    }
    switch (body.decision) {
      case "BUILD":
        return this.persistRoleRequest(cycle, env, "BUILD", "builder");
      case "REWORK":
        return this.persistRoleRequest(cycle, env, "REWORK", "builder");
      case "ACCEPT":
        return this.handoff.transition(cycle.cycle_id, "ACCEPTED", {
          accepted_candidate_sha: cycle.latest_candidate_sha,
          recovery_reason: null,
          recovery_target_request_id: null,
          recovery_lineage_id: null,
          current_request_id: null,
        });
      case "RETRY":
        return this.applySemanticRetry(cycle, env);
      case "REDESIGN":
        return this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
          recovery_reason: "REDESIGN",
          recovery_target_request_id: null,
          recovery_lineage_id: null,
          current_request_id: null,
        });
      case "HUMAN_GATE":
        this.handoff.createHumanGate({
          cycleId: cycle.cycle_id,
          decisionEnvelopeId: env.envelope_id,
          purpose: body.human_gate_purpose ?? "Human gate",
          allowedChoices: body.human_gate_choices ?? ["ACCEPT", "ABORT"],
        });
        // Preserve recovery_target_request_id and recovery_lineage_id through HUMAN_GATE.
        return this.handoff.transition(cycle.cycle_id, "HUMAN_GATE", {
          current_request_id: null,
        });
      case "ABORT":
        return this.handoff.transition(cycle.cycle_id, "ABORTED", {
          recovery_reason: "ABORT",
          recovery_target_request_id: null,
          recovery_lineage_id: null,
          current_request_id: null,
        });
    }
  }

  /**
   * Program Control semantic RETRY: new logical Control Request with new request_id,
   * authorized by this Decision, retry_of_request_id = failed recovery target.
   * Distinct from automatic same-request_id dispatch attempts.
   */
  private applySemanticRetry(
    cycle: CycleRecord,
    decision: CanonicalEnvelope<PcDecisionBody>,
  ): CycleRecord {
    const failedId = cycle.recovery_target_request_id;
    if (!failedId) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY requires a durable recovery_target_request_id",
      );
    }
    const failed = this.handoff.assertRetryableRecoveryTarget(cycle, failedId);
    const role = failed.body.target_role as "builder" | "reviewer";

    const ts = nowIso(() => this.handoff.store.now());
    const requestId = this.handoff.store.nextId("req");
    const body: ControlRequestBody = {
      action: failed.body.action,
      target_role: role,
      work_package_ref: failed.body.work_package_ref,
      base_sha: failed.body.base_sha,
      target_sha: failed.body.target_sha,
      authoritative_references: [...failed.body.authoritative_references],
      required_capabilities: [...failed.body.required_capabilities],
      expected_result_kind: failed.body.expected_result_kind,
      stop_condition: failed.body.stop_condition,
      authorized_by_decision_id: decision.envelope_id,
      authorized_finding_ids: [...failed.body.authorized_finding_ids],
      retry_of_request_id: failedId,
    };
    this.handoff.persistEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: this.handoff.store.nextId("env"),
      kind: "control_request",
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      from_role: "program_control",
      to_role: role,
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
        action: body.action,
        authorized_by_decision_id: decision.envelope_id,
        retry_of_request_id: failedId,
      },
    });
    const nextState: CycleState =
      role === "reviewer" ? "DISPATCHING_REVIEW" : "DISPATCHING_BUILD";
    return this.handoff.transition(cycle.cycle_id, nextState, {
      current_request_id: requestId,
      recovery_reason: null,
      recovery_target_request_id: null,
      recovery_lineage_id: null,
    });
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
      retry_of_request_id: null,
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
      recovery_target_request_id: null,
      recovery_lineage_id: null,
    });
  }

  private persistReviewRequest(cycle: CycleRecord, targetSha: string): CycleRecord {
    if (!this.handoff.mayAutoDispatchReview(cycle)) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Automatic review requires durable Program Control policy provenance",
      );
    }
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
      authorized_by_decision_id: cycle.policy_authorized_by_decision_id,
      authorized_finding_ids: [],
      retry_of_request_id: null,
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
        authorized_by_decision_id: cycle.policy_authorized_by_decision_id,
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
    if (req.body.action === "REVIEW") return "DISPATCHING_REVIEW";
    if (req.body.target_role === "program_control") return "DISPATCHING_PC";
    return "DISPATCHING_BUILD";
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
          recovery_target_request_id: null,
          recovery_lineage_id: null,
        });
      }
      if (choice === "ABORT") {
        return this.handoff.transition(cycle.cycle_id, "ABORTED", {
          recovery_reason: "ABORT",
          recovery_target_request_id: null,
          recovery_lineage_id: null,
        });
      }
      if (choice === "RETRY") {
        // Human Gate RETRY returns to PC preserving recovery target + lineage for PC RETRY.
        return this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
          current_request_id: null,
        });
      }
      return this.handoff.transition(cycle.cycle_id, "AWAITING_PC", {
        recovery_reason: choice,
        current_request_id: null,
        recovery_target_request_id: null,
        recovery_lineage_id: null,
      });
    });
    return { cycle: next, action: "human_gate_applied", detail: { choice } };
  }
}

export function classifyFailure(code: string): FailureClass {
  if (code === "RESULT_INVALID") return "RESULT_INVALID";
  if (code === "RESULT_STALE" || code === "STALE_FENCE") return "RESULT_STALE";
  if (code === "CAPABILITY_BLOCK") return "CAPABILITY_BLOCK";
  if (code === "CREDENTIAL_UNAVAILABLE") return "CREDENTIAL_UNAVAILABLE";
  if (code === "AGENT_UNAVAILABLE") return "AGENT_UNAVAILABLE";
  if (
    code === "TARGET_SHA_REQUIRED" ||
    code === "TARGET_SHA_UNRESOLVED" ||
    code === "TARGET_SHA_MISMATCH" ||
    code === "TARGET_SHA_INVALID" ||
    code === "WORKSPACE_DIRTY" ||
    code === "SOURCE_MUTATION"
  ) {
    return "RESULT_INVALID";
  }
  return "RUNTIME_ERROR";
}
