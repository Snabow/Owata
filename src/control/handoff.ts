import { ControlError } from "./types.js";
import type { ControlStore } from "./store.js";
import { nowIso } from "./ids.js";
import {
  parseCanonicalEnvelope,
  parseCyclePolicy,
  PROTOCOL_V1,
  type CanonicalEnvelope,
  type CyclePolicy,
  type CycleState,
  type EnvelopeKind,
  type FailureClass,
  type LogicalRole,
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
      recovery_reason: cycle.recovery_reason,
    };
  }

  createCycle(args: {
    projectId: string;
    workPackageRef: string;
    baseSha?: string | null;
    policy: CyclePolicy;
    maxDispatchRetries?: number;
  }): CycleRecord {
    const ts = nowIso(() => this.store.now());
    const cycleId = this.store.nextId("cyc");
    return this.store.runImmediate(() => {
      this.store.db
        .prepare(
          `INSERT INTO cycles (
             cycle_id, project_id, work_package_ref, base_sha,
             latest_candidate_sha, accepted_candidate_sha, state,
             current_request_id, policy_json, max_dispatch_retries,
             recovery_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, 'AWAITING_PC', NULL, ?, ?, NULL, ?, ?)`,
        )
        .run(
          cycleId,
          args.projectId,
          args.workPackageRef,
          args.baseSha ?? null,
          JSON.stringify(args.policy),
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
          policy: args.policy,
        },
      });
      return this.getCycle(cycleId)!;
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
      .prepare(`SELECT body_json FROM envelopes WHERE envelope_id = ?`)
      .get(parsed.envelope_id) as { body_json: string } | undefined;
    if (existing) {
      const prev = parseCanonicalEnvelope({
        ...parsed,
        body: JSON.parse(existing.body_json),
      });
      if (JSON.stringify(prev.body) !== JSON.stringify(parsed.body)) {
        throw new ControlError(
          "DUPLICATE_ENVELOPE",
          `envelope_id ${parsed.envelope_id} already exists with a different body`,
        );
      }
      return parsed;
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
      this.transition(args.cycleId, "RECOVERY_REQUIRED", {
        recovery_reason: "dispatch_retry_budget_exhausted",
      });
      this.store.appendEvent("cycle.recovery_required", {
        project_id: cycle.project_id,
        work_id: null,
        ts,
        payload: {
          cycle_id: args.cycleId,
          request_id: args.requestId,
          reason: "dispatch_retry_budget_exhausted",
          attempts: attempt - 1,
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
    const ts = nowIso(() => this.store.now());
    const cycle = this.requireCycle(args.cycleId);
    this.store.appendEvent("cycle.capability_blocked", {
      project_id: cycle.project_id,
      work_id: null,
      ts,
      payload: {
        cycle_id: args.cycleId,
        request_id: args.requestId,
        missing: args.missing,
      },
    });
    this.transition(args.cycleId, "RECOVERY_REQUIRED", {
      recovery_reason: "CAPABILITY_BLOCK",
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
