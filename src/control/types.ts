export const SCHEMA_VERSION = 4;

export type ProjectState = "ACTIVE";

export type WorkState = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type VerificationStatus = "PASS" | "FAIL";

/**
 * Durable classification of a finished (or abandoned) attempt.
 * PASS = execution_ok AND verification PASS (combined completion gate).
 * FAIL = finished execute/verify path but overall gate failed (includes false+PASS).
 * SETUP_ERROR = durable spec/handler preparation failed before execute.
 * EXEC_ERROR / VERIFY_ERROR = handler throw during execute/verify.
 * RESULT_ERROR = execution occurred but result could not be durably represented.
 * ABANDONED = ownership ended before final classification.
 */
export type AttemptOutcome =
  | "PASS"
  | "FAIL"
  | "SETUP_ERROR"
  | "EXEC_ERROR"
  | "VERIFY_ERROR"
  | "RESULT_ERROR"
  | "ABANDONED";

export type EventType =
  | "project.created"
  | "work.created"
  | "work.claimed"
  | "work.lease_expired"
  | "work.attempt_started"
  | "work.attempt_finished"
  | "work.execution_started"
  | "work.execution_finished"
  | "work.verification_failed"
  | "work.verification_passed"
  | "work.repair_applied"
  | "work.attempt_abandoned"
  | "work.failed"
  | "work.completed";

export interface ProjectRecord {
  project_id: string;
  name: string;
  state: ProjectState;
  created_at: string;
  updated_at: string;
}

export interface WorkRecord {
  work_id: string;
  project_id: string;
  title: string;
  state: WorkState;
  attempt: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  task_type: string | null;
  task_input: Record<string, unknown> | null;
  repair_count: number;
  max_repairs: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRecord {
  attempt_id: string;
  work_id: string;
  attempt_number: number;
  worker_id: string;
  started_at: string;
  finished_at: string | null;
  execution_ok: boolean | null;
  result_json: Record<string, unknown> | null;
  verification_status: VerificationStatus | null;
  verification_detail: string | null;
  attempt_outcome: AttemptOutcome | null;
  repair_applied: boolean;
  repair_note: string | null;
  created_at: string;
}

export interface EventRecord {
  event_id: string;
  /** Authoritative total order. Distinct from event_id (identity) and ts (observational). */
  event_seq: number;
  ts: string;
  event_type: EventType;
  project_id: string | null;
  work_id: string | null;
  payload: Record<string, unknown>;
  jsonl_flushed: number;
}

export class ControlError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}
