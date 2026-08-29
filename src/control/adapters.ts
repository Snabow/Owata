import type {
  Capability,
  CanonicalEnvelope,
  ControlRequestBody,
  CyclePolicy,
  CycleState,
  LogicalRole,
} from "./protocol.js";

export interface AdapterIdentity {
  adapter_id: string;
  role: LogicalRole;
}

export interface PreflightResult {
  ok: boolean;
  missing: Capability[];
}

export interface RoleAdapter {
  readonly identity: AdapterIdentity;
  capabilities(): Capability[];
  preflight(required: Capability[]): PreflightResult;
}

export interface CycleSnapshot {
  cycle_id: string;
  state: CycleState;
  work_package_ref: string;
  base_sha: string | null;
  latest_candidate_sha: string | null;
  accepted_candidate_sha: string | null;
  current_request_id: string | null;
  policy: CyclePolicy;
  policy_authorized_by_decision_id: string | null;
  recovery_target_request_id: string | null;
  recovery_lineage_id: string | null;
  recovery_reason: string | null;
}

export interface ProgramControlInput {
  cycle: CycleSnapshot;
  envelopes: CanonicalEnvelope[];
}

/**
 * Lease/ownership context for a real (long-running) Builder invocation.
 * Fake adapters may ignore it entirely.
 */
export interface BuilderDispatchContext {
  dispatch_id: string;
  attempt_number: number;
  fence_token: string;
  lease_expires_at: string;
}

export interface BuilderInput {
  cycle: CycleSnapshot;
  request: CanonicalEnvelope<ControlRequestBody>;
  /** Present when the Dispatcher owns a live dispatch lease for this invocation. */
  dispatch?: BuilderDispatchContext;
  /** Aborted when the Dispatcher loses the lease (heartbeat renew failure). */
  signal?: AbortSignal;
}

export interface ReviewerInput {
  cycle: CycleSnapshot;
  request: CanonicalEnvelope<ControlRequestBody>;
}

/**
 * Adapter output is untrusted until parseCanonicalEnvelope + fencing succeed.
 * Implementations return a candidate envelope object (or malformed garbage in tests).
 * Sync returns remain valid; real adapters may return a Promise.
 */
export interface ProgramControlAdapter extends RoleAdapter {
  decide(input: ProgramControlInput): unknown | Promise<unknown>;
}

export interface BuilderAdapter extends RoleAdapter {
  build(input: BuilderInput): unknown | Promise<unknown>;
}

export interface ReviewerAdapter extends RoleAdapter {
  review(input: ReviewerInput): unknown | Promise<unknown>;
}

export function defaultPreflight(
  available: Capability[],
  required: Capability[],
): PreflightResult {
  const have = new Set(available);
  const missing = required.filter((c) => !have.has(c));
  return { ok: missing.length === 0, missing };
}
