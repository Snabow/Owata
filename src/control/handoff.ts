import { ControlError } from "./types.js";
import type { ControlStore } from "./store.js";
import { nowIso } from "./ids.js";
import {
  parseCanonicalEnvelope,
  parseCyclePolicy,
  PROTOCOL_V1,
  canonicalEnvelopeIdentity,
  type CanonicalEnvelope,
  type ControlRequestBody,
  type CyclePolicy,
  type CycleState,
  type EnvelopeKind,
  type FailureClass,
  type LogicalRole,
  type PcDecisionBody,
  type PcDecisionKind,
} from "./protocol.js";
import type { CycleSnapshot } from "./adapters.js";

export type DispatchState =
  | "CLAIMED"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "RECOVERED";

export interface CycleRecord {
  cycle_id: string;
  project_id: string;
  work_package_ref: string;
  base_sha: string | null;
  latest_candidate_sha: string | null;
  accepted_candidate_sha: string | null;
  state: CycleState;
  current_request_id: string | null;
  policy: CyclePolicy;
  policy_authorized_by_decision_id: string | null;
  recovery_target_request_id: string | null;
  recovery_lineage_id: string | null;
  max_dispatch_retries: number;
  recovery_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DispatchRecord {
  dispatch_id: string;
  cycle_id: string;
  request_id: string;
  attempt_number: number;
  fence_token: string;
  owner: string;
  target_role: LogicalRole;
  state: DispatchState;
  lease_expires_at: string;
  result_envelope_id: string | null;
  failure_class: FailureClass | null;
  failure_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface HumanGateRecord {
  gate_id: string;
  cycle_id: string;
  decision_envelope_id: string;
  purpose: string;
  allowed_choices: PcDecisionKind[];
  state: "OPEN" | "ANSWERED";
  selected_choice: PcDecisionKind | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function mapCycle(row: Record<string, unknown>): CycleRecord {
  return {
    cycle_id: String(row.cycle_id),
    project_id: String(row.project_id),
    work_package_ref: String(row.work_package_ref),
    base_sha: row.base_sha == null ? null : String(row.base_sha),
    latest_candidate_sha:
      row.latest_candidate_sha == null ? null : String(row.latest_candidate_sha),
    accepted_candidate_sha:
      row.accepted_candidate_sha == null
        ? null
        : String(row.accepted_candidate_sha),
    state: String(row.state) as CycleState,
    current_request_id:
      row.current_request_id == null ? null : String(row.current_request_id),
    policy: parseCyclePolicy(JSON.parse(String(row.policy_json))),
    policy_authorized_by_decision_id:
      row.policy_authorized_by_decision_id == null
        ? null
        : String(row.policy_authorized_by_decision_id),
    recovery_target_request_id:
      row.recovery_target_request_id == null
        ? null
        : String(row.recovery_target_request_id),
    recovery_lineage_id:
      row.recovery_lineage_id == null ? null : String(row.recovery_lineage_id),
    max_dispatch_retries: Number(row.max_dispatch_retries),
    recovery_reason:
      row.recovery_reason == null ? null : String(row.recovery_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapDispatch(row: Record<string, unknown>): DispatchRecord {
  return {
    dispatch_id: String(row.dispatch_id),
    cycle_id: String(row.cycle_id),
    request_id: String(row.request_id),
    attempt_number: Number(row.attempt_number),
    fence_token: String(row.fence_token),
    owner: String(row.owner),
    target_role: String(row.target_role) as LogicalRole,
    state: String(row.state) as DispatchState,
    lease_expires_at: String(row.lease_expires_at),
    result_envelope_id:
      row.result_envelope_id == null ? null : String(row.result_envelope_id),
    failure_class:
      row.failure_class == null ? null : (String(row.failure_class) as FailureClass),
    failure_detail:
      row.failure_detail == null ? null : String(row.failure_detail),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapGate(row: Record<string, unknown>): HumanGateRecord {
  return {
    gate_id: String(row.gate_id),
    cycle_id: String(row.cycle_id),
    decision_envelope_id: String(row.decision_envelope_id),
    purpose: String(row.purpose),
    allowed_choices: JSON.parse(String(row.allowed_choices_json)) as PcDecisionKind[],
    state: String(row.state) as "OPEN" | "ANSWERED",
    selected_choice:
      row.selected_choice == null
        ? null
        : (String(row.selected_choice) as PcDecisionKind),
    note: row.note == null ? null : String(row.note),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class HandoffStore {
  constructor(readonly store: ControlStore) {}

  snapshot(cycle: CycleRecord): CycleSnapshot {
    return {
      cycle_id: cycle.cycle_id,
      state: cycle.state,
      work_package_ref: cycle.work_package_ref,
      base_sha: cycle.base_sha,
      latest_candidate_sha: cycle.latest_candidate_sha,
      accepted_candidate_sha: cycle.accepted_candidate_sha,
      current_request_id: cycle.current_request_id,
      policy: cycle.policy,
      policy_authorized_by_decision_id: cycle.policy_authorized_by_decision_id,
      recovery_target_request_id: cycle.recovery_target_request_id,
      recovery_lineage_id: cycle.recovery_lineage_id,
      recovery_reason: cycle.recovery_reason,
    };
  }

  createCycle(args: {
    projectId: string;
    workPackageRef: string;
    baseSha?: string | null;
    policy?: CyclePolicy;
    maxDispatchRetries?: number;
  }): CycleRecord {
    const policy = args.policy ?? { on_builder_candidate: "AWAIT_PC" };
    if (policy.on_builder_candidate === "DISPATCH_REVIEW") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "DISPATCH_REVIEW requires Program Control authorization; start with AWAIT_PC and install via Decision",
      );
    }
    const ts = nowIso(() => this.store.now());
    const cycleId = this.store.nextId("cyc");
    return this.store.runImmediate(() => {
      this.store.db
        .prepare(
          `INSERT INTO cycles (
             cycle_id, project_id, work_package_ref, base_sha,
             latest_candidate_sha, accepted_candidate_sha, state,
             current_request_id, policy_json, policy_authorized_by_decision_id,
             recovery_target_request_id, recovery_lineage_id, max_dispatch_retries,
             recovery_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, 'AWAITING_PC', NULL, ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
        )
        .run(
          cycleId,
          args.projectId,
          args.workPackageRef,
          args.baseSha ?? null,
          JSON.stringify(policy),
          args.maxDispatchRetries ?? 3,
          ts,
          ts,
        );
      this.store.appendEvent("cycle.created", {
        project_id: args.projectId,
        work_id: null,
        ts,
        payload: {
          cycle_id: cycleId,
          work_package_ref: args.workPackageRef,
          policy,
        },
      });
      return this.getCycle(cycleId)!;
    });
  }

  /**
   * Single authoritative validation path for automatic-review / policy provenance.
   * A Decision authorizes a policy only when it is the canonical ACCEPTED result of
   * a Program Control dispatch for this cycle, with matching install_policy.
   */
  assertPolicyProvenance(
    cycleId: string,
    decisionEnvelopeId: string,
    expectedPolicy: CyclePolicy,
  ): CanonicalEnvelope {
    const decision = this.getEnvelope(decisionEnvelopeId);
    if (!decision || decision.kind !== "program_control_decision") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy requires a program_control_decision envelope",
      );
    }
    if (decision.from_role !== "program_control") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision from_role must be program_control",
      );
    }
    if (decision.cycle_id !== cycleId) {
      throw new ControlError("POLICY_PROVENANCE", "Policy decision cycle mismatch");
    }
    if (!decision.request_id) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision must reference a PC request_id",
      );
    }

    const request = this.listEnvelopes(cycleId).find(
      (e) =>
        e.kind === "control_request" && e.request_id === decision.request_id,
    ) as CanonicalEnvelope<ControlRequestBody> | undefined;
    if (!request) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision request envelope missing",
      );
    }
    if (request.kind !== "control_request") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision must correlate with a control_request",
      );
    }
    if (request.cycle_id !== cycleId) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision request cycle mismatch",
      );
    }
    if (request.from_role !== "dispatcher") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "PC Control Request from_role must be dispatcher",
      );
    }
    if (request.to_role !== "program_control") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "PC Control Request to_role must be program_control",
      );
    }
    if (request.body.target_role !== "program_control") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision must correlate with a program_control request",
      );
    }
    if (
      request.body.action !== "DECIDE" &&
      request.body.action !== "ADJUDICATE"
    ) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision must correlate with DECIDE/ADJUDICATE",
      );
    }
    if (request.body.expected_result_kind !== "program_control_decision") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "PC Control Request expected_result_kind must be program_control_decision",
      );
    }

    const accepted = this.acceptedDispatch(cycleId, decision.request_id);
    if (!accepted) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Policy Decision is not the result of an ACCEPTED PC dispatch",
      );
    }
    if (accepted.target_role !== "program_control") {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Accepted provenance dispatch must target program_control",
      );
    }
    if (accepted.result_envelope_id !== decision.envelope_id) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Accepted dispatch result_envelope_id must match Decision",
      );
    }

    const body = decision.body as PcDecisionBody;
    if (!body.install_policy) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Decision install_policy is required to authorize policy",
      );
    }
    if (
      body.install_policy.on_builder_candidate !==
      expectedPolicy.on_builder_candidate
    ) {
      throw new ControlError(
        "POLICY_PROVENANCE",
        "Decision install_policy does not match the authorized policy",
      );
    }
    return decision;
  }

  hasValidPolicyProvenance(
    cycleId: string,
    decisionEnvelopeId: string,
    expectedPolicy: CyclePolicy,
  ): boolean {
    try {
      this.assertPolicyProvenance(cycleId, decisionEnvelopeId, expectedPolicy);
      return true;
    } catch (err) {
      if (err instanceof ControlError && err.code === "POLICY_PROVENANCE") {
        return false;
      }
      throw err;
    }
  }

  installPolicyFromDecision(
    cycleId: string,
    decisionEnvelopeId: string,
    policy: CyclePolicy,
  ): CycleRecord {
    this.assertPolicyProvenance(cycleId, decisionEnvelopeId, policy);
    const ts = nowIso(() => this.store.now());
    this.store.db
      .prepare(
        `UPDATE cycles
         SET policy_json = ?, policy_authorized_by_decision_id = ?, updated_at = ?
         WHERE cycle_id = ?`,
      )
      .run(JSON.stringify(policy), decisionEnvelopeId, ts, cycleId);
    return this.requireCycle(cycleId);
  }

  mayAutoDispatchReview(cycle: CycleRecord): boolean {
    if (cycle.policy.on_builder_candidate !== "DISPATCH_REVIEW") return false;
    if (!cycle.policy_authorized_by_decision_id) return false;
    return this.hasValidPolicyProvenance(
      cycle.cycle_id,
      cycle.policy_authorized_by_decision_id,
      cycle.policy,
    );
  }

  /**
   * Program Control semantic RETRY may only resume a genuinely failed Builder/Reviewer
   * request for the CURRENT recovery lineage. recovery_target_request_id alone is not proof.
   */
  assertRetryableRecoveryTarget(
    cycle: CycleRecord,
    requestId: string,
  ): CanonicalEnvelope<ControlRequestBody> {
    if (!cycle.recovery_reason) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY requires an active recovery lineage (recovery_reason)",
      );
    }
    if (!cycle.recovery_lineage_id) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY requires an active recovery_lineage_id",
      );
    }
    if (cycle.recovery_target_request_id !== requestId) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery_target_request_id mismatch",
      );
    }
    const lineageEvent = this.findCurrentRecoveryLineageEvent(cycle);
    if (!lineageEvent) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY missing durable recovery-lineage event",
      );
    }
    const payload = lineageEvent.payload;
    if (String(payload.cycle_id ?? "") !== cycle.cycle_id) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery-lineage event cycle_id mismatch",
      );
    }
    if (String(payload.recovery_lineage_id ?? "") !== cycle.recovery_lineage_id) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery-lineage event lineage_id mismatch",
      );
    }
    if (String(payload.request_id ?? "") !== requestId) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery-lineage event request_id mismatch",
      );
    }
    if (String(payload.reason ?? "") !== cycle.recovery_reason) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery-lineage event reason mismatch",
      );
    }
    if (requestId === cycle.current_request_id) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery target must not be the accepted PC recovery request",
      );
    }
    const failed = this.listEnvelopes(cycle.cycle_id).find(
      (e) => e.kind === "control_request" && e.request_id === requestId,
    ) as CanonicalEnvelope<ControlRequestBody> | undefined;
    if (!failed || failed.cycle_id !== cycle.cycle_id) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery target Control Request missing or cycle mismatch",
      );
    }
    const role = failed.body.target_role;
    if (role !== "builder" && role !== "reviewer") {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery target must be a Builder or Reviewer Control Request",
      );
    }
    if (failed.to_role !== role) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery target to_role must match body.target_role",
      );
    }
    if (
      failed.body.action !== "BUILD" &&
      failed.body.action !== "REWORK" &&
      failed.body.action !== "REVIEW"
    ) {
      throw new ControlError(
        "PROTOCOL",
        `RETRY cannot resume action ${failed.body.action}`,
      );
    }
    if (this.acceptedDispatch(cycle.cycle_id, requestId)) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY cannot target a request that already has an ACCEPTED result",
      );
    }
    if (!this.hasDurableFailureEvidence(cycle.cycle_id, requestId)) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY recovery target lacks durable failure/recovery evidence",
      );
    }
    if (
      !this.failureEvidenceCompatibleWithLineage(
        cycle.cycle_id,
        requestId,
        cycle.recovery_lineage_id,
      )
    ) {
      throw new ControlError(
        "PROTOCOL",
        "RETRY failure evidence is not compatible with the current recovery lineage",
      );
    }
    return failed;
  }

  /** Authoritative durable event establishing the cycle's current recovery lineage. */
  findCurrentRecoveryLineageEvent(
    cycle: CycleRecord,
  ): { event_id: string; event_type: string; payload: Record<string, unknown> } | undefined {
    if (!cycle.recovery_lineage_id) return undefined;
    return this.store.listEvents().find(
      (e) =>
        e.event_type === "cycle.recovery_required" &&
        String(e.payload.recovery_lineage_id ?? "") === cycle.recovery_lineage_id,
    );
  }

  /**
   * Failure evidence for the target must relate to this lineage (not merely any historical
   * failure for the same request_id from an unrelated era). The lineage event itself binds
   * request_id; additional evidence must mention the request and either share the lineage id
   * or be a dispatch-state failure for that request.
   */
  failureEvidenceCompatibleWithLineage(
    cycleId: string,
    requestId: string,
    lineageId: string,
  ): boolean {
    const rows = this.store.db
      .prepare(
        `SELECT state FROM dispatches WHERE cycle_id = ? AND request_id = ?`,
      )
      .all(cycleId, requestId) as Array<{ state: string }>;
    if (
      rows.some(
        (r) =>
          r.state === "REJECTED" ||
          r.state === "EXPIRED" ||
          r.state === "RECOVERED",
      )
    ) {
      return true;
    }
    return this.store.listEvents().some((e) => {
      if (
        e.event_type !== "cycle.recovery_required" &&
        e.event_type !== "cycle.capability_blocked" &&
        e.event_type !== "cycle.result_rejected"
      ) {
        return false;
      }
      if (String(e.payload.request_id ?? "") !== requestId) return false;
      if (e.payload.cycle_id != null && String(e.payload.cycle_id) !== cycleId) {
        return false;
      }
      const eventLineage = e.payload.recovery_lineage_id;
      if (eventLineage != null && String(eventLineage) !== lineageId) {
        return false;
      }
      return true;
    });
  }

  /**
   * Single entry point into RECOVERY_REQUIRED for Builder/Reviewer-caused recovery.
   * Creates a new recovery_lineage_id bound to the failed request and appends an
   * authoritative cycle.recovery_required event. Does not fabricate a target for PC-only failures.
   */
  enterRecovery(args: {
    cycleId: string;
    requestId: string | null;
    reason: string;
    evidenceEventType?: "cycle.capability_blocked" | "cycle.result_rejected";
    evidencePayload?: Record<string, unknown>;
  }): CycleRecord {
    const ts = nowIso(() => this.store.now());
    const cycle = this.requireCycle(args.cycleId);
    let recoveryTarget: string | null = null;
    let lineageId: string | null = null;
    let establishLineage = false;

    if (args.requestId) {
      const request = this.listEnvelopes(args.cycleId).find(
        (e) => e.kind === "control_request" && e.request_id === args.requestId,
      ) as CanonicalEnvelope<ControlRequestBody> | undefined;
      if (
        request &&
        (request.body.target_role === "builder" ||
          request.body.target_role === "reviewer")
      ) {
        recoveryTarget = args.requestId;
        lineageId = this.store.nextId("rline");
        establishLineage = true;
      }
    }

    if (args.evidenceEventType) {
      this.store.appendEvent(args.evidenceEventType, {
        project_id: cycle.project_id,
        work_id: null,
        ts,
        payload: {
          cycle_id: args.cycleId,
          request_id: args.requestId,
          recovery_lineage_id: establishLineage
            ? lineageId
            : cycle.recovery_lineage_id,
          ...(args.evidencePayload ?? {}),
        },
      });
    }

    if (establishLineage && lineageId && recoveryTarget) {
      this.store.db
        .prepare(
          `UPDATE cycles SET state = ?, recovery_reason = ?, recovery_target_request_id = ?,
           recovery_lineage_id = ?, current_request_id = NULL, updated_at = ? WHERE cycle_id = ?`,
        )
        .run(
          "RECOVERY_REQUIRED",
          args.reason,
          recoveryTarget,
          lineageId,
          ts,
          args.cycleId,
        );
      this.store.appendEvent("cycle.recovery_required", {
        project_id: cycle.project_id,
        work_id: null,
        ts,
        payload: {
          cycle_id: args.cycleId,
          request_id: recoveryTarget,
          reason: args.reason,
          recovery_lineage_id: lineageId,
          recovery_target_request_id: recoveryTarget,
          ...(args.evidencePayload ?? {}),
        },
      });
      this.store.appendEvent("cycle.transitioned", {
        project_id: cycle.project_id,
        work_id: null,
        ts,
        payload: {
          cycle_id: args.cycleId,
          from: cycle.state,
          to: "RECOVERY_REQUIRED",
          recovery_reason: args.reason,
          recovery_target_request_id: recoveryTarget,
          recovery_lineage_id: lineageId,
        },
      });
    } else {
      // PC-only / non-role recovery: do not invent or rewrite an active Builder/Reviewer lineage.
      if (cycle.recovery_lineage_id) {
        this.store.db
          .prepare(
            `UPDATE cycles SET state = ?, updated_at = ? WHERE cycle_id = ?`,
          )
          .run("RECOVERY_REQUIRED", ts, args.cycleId);
      } else {
        this.store.db
          .prepare(
            `UPDATE cycles SET state = ?, recovery_reason = ?, updated_at = ? WHERE cycle_id = ?`,
          )
          .run("RECOVERY_REQUIRED", args.reason, ts, args.cycleId);
      }
      this.store.appendEvent("cycle.transitioned", {
        project_id: cycle.project_id,
        work_id: null,
        ts,
        payload: {
          cycle_id: args.cycleId,
          from: cycle.state,
          to: "RECOVERY_REQUIRED",
          recovery_reason: cycle.recovery_lineage_id
            ? cycle.recovery_reason
            : args.reason,
          recovery_target_request_id: cycle.recovery_target_request_id,
          recovery_lineage_id: cycle.recovery_lineage_id,
          note: "pc_or_non_role_recovery_preserved_lineage",
        },
      });
    }

    return this.requireCycle(args.cycleId);
  }

  /** Durable failure evidence reconstructible from SQLite (dispatches and/or events). */
  hasDurableFailureEvidence(cycleId: string, requestId: string): boolean {
    const rows = this.store.db
      .prepare(
        `SELECT state FROM dispatches WHERE cycle_id = ? AND request_id = ?`,
      )
      .all(cycleId, requestId) as Array<{ state: string }>;
    if (
      rows.some(
        (r) =>
          r.state === "REJECTED" ||
          r.state === "EXPIRED" ||
          r.state === "RECOVERED",
      )
    ) {
      return true;
    }
    return this.store.listEvents().some((e) => {
      if (
        e.event_type !== "cycle.recovery_required" &&
        e.event_type !== "cycle.capability_blocked" &&
        e.event_type !== "cycle.result_rejected"
      ) {
        return false;
      }
      if (String(e.payload.request_id ?? "") !== requestId) return false;
      if (e.payload.cycle_id != null && String(e.payload.cycle_id) !== cycleId) {
        return false;
      }
      return true;
    });
  }

  getCycle(cycleId: string): CycleRecord | undefined {
    const row = this.store.db
      .prepare(`SELECT * FROM cycles WHERE cycle_id = ?`)
      .get(cycleId) as Record<string, unknown> | undefined;
    return row ? mapCycle(row) : undefined;
  }

  requireCycle(cycleId: string): CycleRecord {
    const cycle = this.getCycle(cycleId);
    if (!cycle) {
      throw new ControlError("CYCLE_NOT_FOUND", `Unknown cycle ${cycleId}`);
    }
    return cycle;
  }

  transition(
    cycleId: string,
    next: CycleState,
    extra?: {
      recovery_reason?: string | null;
      recovery_target_request_id?: string | null;
      recovery_lineage_id?: string | null;
      latest_candidate_sha?: string | null;
      accepted_candidate_sha?: string | null;
      current_request_id?: string | null;
    },
  ): CycleRecord {
    const ts = nowIso(() => this.store.now());
    const current = this.requireCycle(cycleId);
    const recovery =
      extra && "recovery_reason" in extra
        ? extra.recovery_reason ?? null
        : current.recovery_reason;
    this.store.db
      .prepare(
        `UPDATE cycles SET state = ?, recovery_reason = ?, updated_at = ? WHERE cycle_id = ?`,
      )
      .run(next, recovery, ts, cycleId);
    if (extra && "latest_candidate_sha" in extra) {
      this.store.db
        .prepare(`UPDATE cycles SET latest_candidate_sha = ? WHERE cycle_id = ?`)
        .run(extra.latest_candidate_sha ?? null, cycleId);
    }
    if (extra && "accepted_candidate_sha" in extra) {
      this.store.db
        .prepare(`UPDATE cycles SET accepted_candidate_sha = ? WHERE cycle_id = ?`)
        .run(extra.accepted_candidate_sha ?? null, cycleId);
    }
    if (extra && "current_request_id" in extra) {
      this.store.db
        .prepare(`UPDATE cycles SET current_request_id = ? WHERE cycle_id = ?`)
        .run(extra.current_request_id ?? null, cycleId);
    }
    if (extra && "recovery_target_request_id" in extra) {
      this.store.db
        .prepare(`UPDATE cycles SET recovery_target_request_id = ? WHERE cycle_id = ?`)
        .run(extra.recovery_target_request_id ?? null, cycleId);
      // Clearing the recovery target terminates the active lineage unless explicitly preserved.
      if (
        extra.recovery_target_request_id == null &&
        !("recovery_lineage_id" in extra)
      ) {
        this.store.db
          .prepare(`UPDATE cycles SET recovery_lineage_id = NULL WHERE cycle_id = ?`)
          .run(cycleId);
      }
    }
    if (extra && "recovery_lineage_id" in extra) {
      this.store.db
        .prepare(`UPDATE cycles SET recovery_lineage_id = ? WHERE cycle_id = ?`)
        .run(extra.recovery_lineage_id ?? null, cycleId);
    }
    this.store.appendEvent("cycle.transitioned", {
      project_id: current.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: cycleId,
        from: current.state,
        to: next,
        ...extra,
      },
    });
    return this.requireCycle(cycleId);
  }

  persistEnvelope(raw: unknown): CanonicalEnvelope {
    const parsed = parseCanonicalEnvelope(raw);
    const existing = this.store.db
      .prepare(
        `SELECT envelope_id, cycle_id, kind, request_id, from_role, to_role, body_json, created_at
         FROM envelopes WHERE envelope_id = ?`,
      )
      .get(parsed.envelope_id) as Record<string, unknown> | undefined;
    if (existing) {
      const prev = parseCanonicalEnvelope({
        protocol: PROTOCOL_V1,
        envelope_id: String(existing.envelope_id),
        kind: String(existing.kind),
        cycle_id: String(existing.cycle_id),
        request_id: existing.request_id == null ? null : String(existing.request_id),
        from_role: String(existing.from_role),
        to_role: existing.to_role == null ? null : String(existing.to_role),
        created_at: String(existing.created_at),
        body: JSON.parse(String(existing.body_json)),
      });
      if (canonicalEnvelopeIdentity(prev) !== canonicalEnvelopeIdentity(parsed)) {
        throw new ControlError(
          "DUPLICATE_ENVELOPE",
          `envelope_id ${parsed.envelope_id} already exists with conflicting canonical identity`,
        );
      }
      return prev;
    }
    this.store.db
      .prepare(
        `INSERT INTO envelopes (
           envelope_id, cycle_id, kind, request_id, from_role, to_role, body_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.envelope_id,
        parsed.cycle_id,
        parsed.kind,
        parsed.request_id,
        parsed.from_role,
        parsed.to_role,
        JSON.stringify(parsed.body),
        parsed.created_at,
      );
    return parsed;
  }

  listEnvelopes(cycleId: string): CanonicalEnvelope[] {
    const rows = this.store.db
      .prepare(
        `SELECT envelope_id, cycle_id, kind, request_id, from_role, to_role, body_json, created_at
         FROM envelopes WHERE cycle_id = ? ORDER BY rowid ASC`,
      )
      .all(cycleId) as Array<Record<string, unknown>>;
    return rows.map((row) =>
      parseCanonicalEnvelope({
        protocol: PROTOCOL_V1,
        envelope_id: String(row.envelope_id),
        kind: String(row.kind) as EnvelopeKind,
        cycle_id: String(row.cycle_id),
        request_id: row.request_id == null ? null : String(row.request_id),
        from_role: String(row.from_role),
        to_role: row.to_role == null ? null : String(row.to_role),
        created_at: String(row.created_at),
        body: JSON.parse(String(row.body_json)),
      }),
    );
  }

  getEnvelope(envelopeId: string): CanonicalEnvelope | undefined {
    const row = this.store.db
      .prepare(`SELECT * FROM envelopes WHERE envelope_id = ?`)
      .get(envelopeId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return parseCanonicalEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: String(row.envelope_id),
      kind: String(row.kind),
      cycle_id: String(row.cycle_id),
      request_id: row.request_id == null ? null : String(row.request_id),
      from_role: String(row.from_role),
      to_role: row.to_role == null ? null : String(row.to_role),
      created_at: String(row.created_at),
      body: JSON.parse(String(row.body_json)),
    });
  }

  acceptedDispatch(cycleId: string, requestId: string): DispatchRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT * FROM dispatches
         WHERE cycle_id = ? AND request_id = ? AND state = 'ACCEPTED'
         ORDER BY attempt_number DESC`,
      )
      .get(cycleId, requestId) as Record<string, unknown> | undefined;
    return row ? mapDispatch(row) : undefined;
  }

  latestDispatch(cycleId: string, requestId: string): DispatchRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT * FROM dispatches
         WHERE cycle_id = ? AND request_id = ?
         ORDER BY attempt_number DESC`,
      )
      .get(cycleId, requestId) as Record<string, unknown> | undefined;
    return row ? mapDispatch(row) : undefined;
  }

  getDispatch(dispatchId: string): DispatchRecord | undefined {
    const row = this.store.db
      .prepare(`SELECT * FROM dispatches WHERE dispatch_id = ?`)
      .get(dispatchId) as Record<string, unknown> | undefined;
    return row ? mapDispatch(row) : undefined;
  }

  claimDispatch(args: {
    cycleId: string;
    requestId: string;
    targetRole: LogicalRole;
    owner: string;
    leaseMs: number;
  }): DispatchRecord {
    const ts = nowIso(() => this.store.now());
    const cycle = this.requireCycle(args.cycleId);
    if (this.acceptedDispatch(args.cycleId, args.requestId)) {
      throw new ControlError(
        "ALREADY_ACCEPTED",
        `Request ${args.requestId} already has an accepted result`,
      );
    }
    const latest = this.latestDispatch(args.cycleId, args.requestId);
    if (latest?.state === "CLAIMED") {
      const exp = Date.parse(latest.lease_expires_at);
      if (Number.isFinite(exp) && this.store.now().getTime() < exp) {
        throw new ControlError(
          "DISPATCH_OWNED",
          `Request ${args.requestId} is already claimed`,
        );
      }
    }
    const attempt = (latest?.attempt_number ?? 0) + 1;
    if (attempt > cycle.max_dispatch_retries) {
      const roleRequestId =
        args.targetRole === "builder" || args.targetRole === "reviewer"
          ? args.requestId
          : null;
      this.enterRecovery({
        cycleId: args.cycleId,
        requestId: roleRequestId,
        reason: "dispatch_retry_budget_exhausted",
        evidencePayload: {
          attempts: attempt - 1,
          exhausted_request_id: args.requestId,
        },
      });
      throw new ControlError(
        "RETRY_BUDGET",
        "Dispatch retry budget exhausted; Program Control recovery required",
      );
    }
    const dispatchId = this.store.nextId("dsp");
    const fence = this.store.nextId("fence");
    const expires = new Date(this.store.now().getTime() + args.leaseMs).toISOString();
    this.store.db
      .prepare(
        `INSERT INTO dispatches (
           dispatch_id, cycle_id, request_id, attempt_number, fence_token, owner,
           target_role, state, lease_expires_at, result_envelope_id,
           failure_class, failure_detail, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        dispatchId,
        args.cycleId,
        args.requestId,
        attempt,
        fence,
        args.owner,
        args.targetRole,
        expires,
        ts,
        ts,
      );
    if (latest?.state === "CLAIMED") {
      this.store.db
        .prepare(
          `UPDATE dispatches SET state = 'RECOVERED', updated_at = ? WHERE dispatch_id = ?`,
        )
        .run(ts, latest.dispatch_id);
      this.store.appendEvent("cycle.dispatch_recovered", {
        project_id: cycle.project_id,
        work_id: null,
        ts,
        payload: {
          cycle_id: args.cycleId,
          request_id: args.requestId,
          old_dispatch_id: latest.dispatch_id,
          new_dispatch_id: dispatchId,
          attempt_number: attempt,
        },
      });
    }
    this.store.appendEvent("cycle.dispatch_claimed", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: args.cycleId,
        request_id: args.requestId,
        dispatch_id: dispatchId,
        attempt_number: attempt,
        owner: args.owner,
        fence_token: fence,
      },
    });
    return this.getDispatch(dispatchId)!;
  }

  /**
   * Extend the lease of the CURRENT CLAIMED dispatch only.
   * A stale fence, an already ACCEPTED/REJECTED/EXPIRED/RECOVERED dispatch,
   * or a lease that has already lapsed cannot renew — fencing semantics are
   * identical to acceptResult so a superseded owner can never keep itself alive.
   */
  renewDispatchLease(
    dispatchId: string,
    fenceToken: string,
    leaseMs: number,
  ): DispatchRecord {
    const ts = nowIso(() => this.store.now());
    const dispatch = this.getDispatch(dispatchId);
    if (!dispatch) {
      throw new ControlError("DISPATCH_NOT_FOUND", "Unknown dispatch");
    }
    if (dispatch.fence_token !== fenceToken || dispatch.state !== "CLAIMED") {
      throw new ControlError(
        "STALE_FENCE",
        "Dispatch fence is not current; cannot renew lease",
      );
    }
    if (this.store.now().getTime() >= Date.parse(dispatch.lease_expires_at)) {
      throw new ControlError(
        "STALE_FENCE",
        "Dispatch lease already expired; cannot renew",
      );
    }
    const expires = new Date(
      this.store.now().getTime() + leaseMs,
    ).toISOString();
    this.store.db
      .prepare(
        `UPDATE dispatches SET lease_expires_at = ?, updated_at = ?
         WHERE dispatch_id = ? AND fence_token = ? AND state = 'CLAIMED'`,
      )
      .run(expires, ts, dispatchId, fenceToken);
    const cycle = this.requireCycle(dispatch.cycle_id);
    this.store.appendEvent("cycle.lease_renewed", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: dispatch.cycle_id,
        request_id: dispatch.request_id,
        dispatch_id: dispatch.dispatch_id,
        attempt_number: dispatch.attempt_number,
        lease_expires_at: expires,
      },
    });
    return this.getDispatch(dispatchId)!;
  }

  acceptResult(args: {
    dispatchId: string;
    fenceToken: string;
    envelope: CanonicalEnvelope;
  }): DispatchRecord {
    const ts = nowIso(() => this.store.now());
    const dispatch = this.getDispatch(args.dispatchId);
    if (!dispatch) {
      throw new ControlError("DISPATCH_NOT_FOUND", "Unknown dispatch");
    }
    if (dispatch.fence_token !== args.fenceToken || dispatch.state !== "CLAIMED") {
      throw new ControlError("STALE_FENCE", "Dispatch fence is not current");
    }
    if (this.store.now().getTime() >= Date.parse(dispatch.lease_expires_at)) {
      throw new ControlError("STALE_FENCE", "Dispatch lease has expired");
    }
    if (this.acceptedDispatch(dispatch.cycle_id, dispatch.request_id)) {
      throw new ControlError(
        "ALREADY_ACCEPTED",
        "Logical request already has an accepted result",
      );
    }
    this.persistEnvelope(args.envelope);
    this.store.db
      .prepare(
        `UPDATE dispatches
         SET state = 'ACCEPTED', result_envelope_id = ?, updated_at = ?
         WHERE dispatch_id = ?`,
      )
      .run(args.envelope.envelope_id, ts, args.dispatchId);
    const cycle = this.requireCycle(dispatch.cycle_id);
    this.store.appendEvent("cycle.result_accepted", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: dispatch.cycle_id,
        request_id: dispatch.request_id,
        dispatch_id: dispatch.dispatch_id,
        envelope_id: args.envelope.envelope_id,
        kind: args.envelope.kind,
      },
    });
    return this.getDispatch(args.dispatchId)!;
  }

  rejectResult(args: {
    dispatchId: string;
    fenceToken: string;
    failureClass: FailureClass;
    detail: string;
  }): DispatchRecord {
    const ts = nowIso(() => this.store.now());
    const dispatch = this.getDispatch(args.dispatchId);
    if (!dispatch) {
      throw new ControlError("DISPATCH_NOT_FOUND", "Unknown dispatch");
    }
    if (dispatch.fence_token !== args.fenceToken || dispatch.state !== "CLAIMED") {
      throw new ControlError("STALE_FENCE", "Dispatch fence is not current");
    }
    this.store.db
      .prepare(
        `UPDATE dispatches
         SET state = 'REJECTED', failure_class = ?, failure_detail = ?, updated_at = ?
         WHERE dispatch_id = ?`,
      )
      .run(args.failureClass, args.detail.slice(0, 400), ts, args.dispatchId);
    const cycle = this.requireCycle(dispatch.cycle_id);
    this.store.appendEvent("cycle.result_rejected", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: dispatch.cycle_id,
        request_id: dispatch.request_id,
        dispatch_id: dispatch.dispatch_id,
        failure_class: args.failureClass,
        detail: args.detail.slice(0, 400),
      },
    });
    return this.getDispatch(args.dispatchId)!;
  }

  recordCapabilityBlock(args: {
    cycleId: string;
    requestId: string;
    missing: string[];
  }): void {
    const request = this.listEnvelopes(args.cycleId).find(
      (e) => e.kind === "control_request" && e.request_id === args.requestId,
    ) as CanonicalEnvelope<ControlRequestBody> | undefined;
    const roleRequestId =
      request &&
      (request.body.target_role === "builder" ||
        request.body.target_role === "reviewer")
        ? args.requestId
        : null;
    this.enterRecovery({
      cycleId: args.cycleId,
      requestId: roleRequestId,
      reason: "CAPABILITY_BLOCK",
      evidenceEventType: "cycle.capability_blocked",
      evidencePayload: { missing: args.missing },
    });
  }

  recoverExpiredDispatches(now: Date = this.store.now()): number {
    const ts = now.toISOString();
    const rows = this.store.db
      .prepare(
        `SELECT * FROM dispatches
         WHERE state = 'CLAIMED' AND lease_expires_at <= ?`,
      )
      .all(ts) as Array<Record<string, unknown>>;
    let n = 0;
    for (const row of rows) {
      const d = mapDispatch(row);
      this.store.db
        .prepare(
          `UPDATE dispatches SET state = 'EXPIRED', updated_at = ? WHERE dispatch_id = ?`,
        )
        .run(ts, d.dispatch_id);
      const cycle = this.requireCycle(d.cycle_id);
      this.store.appendEvent("cycle.dispatch_recovered", {
        project_id: cycle.project_id,
        work_id: null,
        ts,
        payload: {
          cycle_id: d.cycle_id,
          request_id: d.request_id,
          old_dispatch_id: d.dispatch_id,
          reason: "lease_expired",
        },
      });
      n += 1;
    }
    return n;
  }

  createHumanGate(args: {
    cycleId: string;
    decisionEnvelopeId: string;
    purpose: string;
    allowedChoices: PcDecisionKind[];
  }): HumanGateRecord {
    const ts = nowIso(() => this.store.now());
    const gateId = this.store.nextId("gate");
    const envelope = this.persistEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: this.store.nextId("env"),
      kind: "human_gate",
      cycle_id: args.cycleId,
      request_id: null,
      from_role: "program_control",
      to_role: "human",
      created_at: ts,
      body: {
        gate_id: gateId,
        decision_envelope_id: args.decisionEnvelopeId,
        purpose: args.purpose,
        allowed_choices: args.allowedChoices,
      },
    });
    const body = envelope.body as { gate_id: string };
    this.store.db
      .prepare(
        `INSERT INTO human_gates (
           gate_id, cycle_id, decision_envelope_id, purpose, allowed_choices_json,
           state, selected_choice, note, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'OPEN', NULL, NULL, ?, ?)`,
      )
      .run(
        body.gate_id,
        args.cycleId,
        args.decisionEnvelopeId,
        args.purpose,
        JSON.stringify(args.allowedChoices),
        ts,
        ts,
      );
    const cycle = this.requireCycle(args.cycleId);
    this.store.appendEvent("cycle.human_gate_created", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: args.cycleId,
        gate_id: body.gate_id,
        decision_envelope_id: args.decisionEnvelopeId,
      },
    });
    return this.getHumanGate(body.gate_id)!;
  }

  getHumanGate(gateId: string): HumanGateRecord | undefined {
    const row = this.store.db
      .prepare(`SELECT * FROM human_gates WHERE gate_id = ?`)
      .get(gateId) as Record<string, unknown> | undefined;
    return row ? mapGate(row) : undefined;
  }

  openGateForCycle(cycleId: string): HumanGateRecord | undefined {
    const row = this.store.db
      .prepare(
        `SELECT * FROM human_gates WHERE cycle_id = ? AND state = 'OPEN' ORDER BY created_at DESC`,
      )
      .get(cycleId) as Record<string, unknown> | undefined;
    return row ? mapGate(row) : undefined;
  }

  answerHumanGate(args: {
    gateId: string;
    selectedChoice: PcDecisionKind;
    note?: string | null;
  }): HumanGateRecord {
    const ts = nowIso(() => this.store.now());
    const gate = this.getHumanGate(args.gateId);
    if (!gate) {
      throw new ControlError("GATE_NOT_FOUND", "Unknown human gate");
    }
    if (gate.state !== "OPEN") {
      throw new ControlError("GATE_CLOSED", "Human gate already answered");
    }
    if (!gate.allowed_choices.includes(args.selectedChoice)) {
      throw new ControlError("GATE_CHOICE", "Choice is not allowed");
    }
    this.persistEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: this.store.nextId("env"),
      kind: "human_gate_response",
      cycle_id: gate.cycle_id,
      request_id: null,
      from_role: "human",
      to_role: "program_control",
      created_at: ts,
      body: {
        gate_id: args.gateId,
        selected_choice: args.selectedChoice,
        note: args.note ?? null,
      },
    });
    this.store.db
      .prepare(
        `UPDATE human_gates
         SET state = 'ANSWERED', selected_choice = ?, note = ?, updated_at = ?
         WHERE gate_id = ?`,
      )
      .run(args.selectedChoice, args.note ?? null, ts, args.gateId);
    const cycle = this.requireCycle(gate.cycle_id);
    this.store.appendEvent("cycle.human_gate_answered", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: gate.cycle_id,
        gate_id: args.gateId,
        selected_choice: args.selectedChoice,
      },
    });
    return this.getHumanGate(args.gateId)!;
  }
}
