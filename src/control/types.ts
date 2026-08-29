export const SCHEMA_VERSION = 1;

export type ProjectState = "ACTIVE";

export type WorkState = "QUEUED" | "RUNNING" | "COMPLETED";

export type EventType =
  | "project.created"
  | "work.created"
  | "work.claimed"
  | "work.lease_expired"
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
  created_at: string;
  updated_at: string;
}

export interface EventRecord {
  event_id: string;
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
