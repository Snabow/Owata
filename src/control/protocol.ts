import { ControlError } from "./types.js";

export const PROTOCOL_V1 = "owata.handoff/1";

export type LogicalRole =
  | "program_control"
  | "builder"
  | "reviewer"
  | "human"
  | "dispatcher";

export type EnvelopeKind =
  | "control_request"
  | "builder_result"
  | "reviewer_result"
  | "program_control_decision"
  | "human_gate"
  | "human_gate_response";

export type Capability =
  | "repository_read"
  | "repository_write"
  | "exact_checkout"
  | "command_execution"
  | "dependency_install"
  | "network_access";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "repository_read",
  "repository_write",
  "exact_checkout",
  "command_execution",
  "dependency_install",
  "network_access",
];

export type FailureClass =
  | "CAPABILITY_BLOCK"
  | "AGENT_UNAVAILABLE"
  | "REPO_UNAVAILABLE"
  | "CREDENTIAL_UNAVAILABLE"
  | "RUNTIME_ERROR"
  | "RESULT_INVALID"
  | "RESULT_STALE"
  | "PRODUCT_FAILURE";

export type ControlAction =
  | "DECIDE"
  | "ADJUDICATE"
  | "BUILD"
  | "REWORK"
  | "REVIEW";

export type PcDecisionKind =
  | "BUILD"
  | "REWORK"
  | "ACCEPT"
  | "RETRY"
  | "REDESIGN"
  | "HUMAN_GATE"
  | "ABORT";

export type BuilderStatus = "CANDIDATE_READY" | "BLOCKED" | "FAILED";

export type ReviewerVerdict = "PASS" | "REWORK" | "BLOCK";

export type CycleState =
  | "AWAITING_PC"
  | "DISPATCHING_PC"
  | "DISPATCHING_BUILD"
  | "DISPATCHING_REVIEW"
  | "HUMAN_GATE"
  | "RECOVERY_REQUIRED"
  | "ACCEPTED"
  | "ABORTED";

export type BuilderCandidatePolicy = "DISPATCH_REVIEW" | "AWAIT_PC";

export interface CyclePolicy {
  on_builder_candidate: BuilderCandidatePolicy;
}

export interface PolicyInstall {
  on_builder_candidate: BuilderCandidatePolicy;
}

export interface EnvelopeMeta {
  protocol: typeof PROTOCOL_V1;
  envelope_id: string;
  kind: EnvelopeKind;
  cycle_id: string;
  request_id: string | null;
  from_role: LogicalRole;
  to_role: LogicalRole | null;
  created_at: string;
}

export interface Finding {
  finding_id: string;
  severity: string;
  summary: string;
}

export interface ControlRequestBody {
  action: ControlAction;
  target_role: LogicalRole;
  work_package_ref: string;
  base_sha: string | null;
  target_sha: string | null;
  authoritative_references: string[];
  required_capabilities: Capability[];
  expected_result_kind: EnvelopeKind;
  stop_condition: string | null;
  authorized_by_decision_id: string | null;
  authorized_finding_ids: string[];
  /**
   * When set, this Control Request is a Program Control semantic RETRY of a
   * prior exhausted logical request (new request_id; fresh automatic dispatch budget).
   */
  retry_of_request_id: string | null;
}

export interface BuilderResultBody {
  status: BuilderStatus;
  candidate_sha: string | null;
  evidence_refs: string[];
  notes: string | null;
}

export interface ReviewerResultBody {
  target_sha: string;
  verdict: ReviewerVerdict;
  findings: Finding[];
  evidence_refs: string[];
}

export interface PcDecisionBody {
  decision: PcDecisionKind;
  rationale: string | null;
  authorized_finding_ids: string[];
  rework_scope: string | null;
  human_gate_purpose: string | null;
  human_gate_choices: PcDecisionKind[] | null;
  /** When set, installs standing transition policy authorized by this Decision. */
  install_policy: PolicyInstall | null;
}

export interface HumanGateBody {
  gate_id: string;
  decision_envelope_id: string;
  purpose: string;
  allowed_choices: PcDecisionKind[];
}

export interface HumanGateResponseBody {
  gate_id: string;
  selected_choice: PcDecisionKind;
  note: string | null;
}

export type EnvelopeBody =
  | ControlRequestBody
  | BuilderResultBody
  | ReviewerResultBody
  | PcDecisionBody
  | HumanGateBody
  | HumanGateResponseBody;

export interface CanonicalEnvelope<T extends EnvelopeBody = EnvelopeBody>
  extends EnvelopeMeta {
  body: T;
}

const FORBIDDEN_KEY = /^(password|passwd|api_key|apikey|oauth_token|access_token|refresh_token|secret|private_key|credential)$/i;

const ROLES = new Set<LogicalRole>([
  "program_control",
  "builder",
  "reviewer",
  "human",
  "dispatcher",
]);

const KINDS = new Set<EnvelopeKind>([
  "control_request",
  "builder_result",
  "reviewer_result",
  "program_control_decision",
  "human_gate",
  "human_gate_response",
]);

const CAPS = new Set<string>(ALL_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function rejectForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => rejectForbiddenKeys(item, `${path}[${i}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new ControlError(
        "RESULT_INVALID",
        `Forbidden credential-like field ${path}.${key}`,
      );
    }
    rejectForbiddenKeys(value[key], `${path}.${key}`);
  }
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ControlError("RESULT_INVALID", `Missing string field ${key}`);
  }
  if (v.length > 4000) {
    throw new ControlError("RESULT_INVALID", `Field ${key} exceeds bound`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (v == null) return null;
  if (typeof v !== "string") {
    throw new ControlError("RESULT_INVALID", `Field ${key} must be string or null`);
  }
  if (v.length > 4000) {
    throw new ControlError("RESULT_INVALID", `Field ${key} exceeds bound`);
  }
  return v.length === 0 ? null : v;
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ControlError("RESULT_INVALID", `Field ${key} must be string[]`);
  }
  return v.map((x) => String(x));
}

function parseCapabilities(raw: unknown): Capability[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ControlError("RESULT_INVALID", "required_capabilities must be an array");
  }
  const out: Capability[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !CAPS.has(item)) {
      throw new ControlError("RESULT_INVALID", `Unknown capability ${String(item)}`);
    }
    out.push(item as Capability);
  }
  return out;
}

function parseControlRequest(body: Record<string, unknown>): ControlRequestBody {
  const action = requireString(body, "action") as ControlAction;
  if (!["DECIDE", "ADJUDICATE", "BUILD", "REWORK", "REVIEW"].includes(action)) {
    throw new ControlError("RESULT_INVALID", `Unknown action ${action}`);
  }
  const target = requireString(body, "target_role") as LogicalRole;
  if (!ROLES.has(target)) {
    throw new ControlError("RESULT_INVALID", `Unknown target_role ${target}`);
  }
  const expected = requireString(body, "expected_result_kind") as EnvelopeKind;
  if (!KINDS.has(expected)) {
    throw new ControlError("RESULT_INVALID", `Unknown expected_result_kind`);
  }
  const findings = requireStringArray(body, "authorized_finding_ids");
  if (action === "REWORK" && findings.length === 0) {
    throw new ControlError(
      "RESULT_INVALID",
      "REWORK request must reference authorized finding IDs",
    );
  }
  return {
    action,
    target_role: target,
    work_package_ref: requireString(body, "work_package_ref"),
    base_sha: optionalString(body, "base_sha"),
    target_sha: optionalString(body, "target_sha"),
    authoritative_references: requireStringArray(body, "authoritative_references"),
    required_capabilities: parseCapabilities(body.required_capabilities),
    expected_result_kind: expected,
    stop_condition: optionalString(body, "stop_condition"),
    authorized_by_decision_id: optionalString(body, "authorized_by_decision_id"),
    authorized_finding_ids: findings,
    retry_of_request_id: optionalString(body, "retry_of_request_id"),
  };
}

function parseBuilderResult(body: Record<string, unknown>): BuilderResultBody {
  const status = requireString(body, "status") as BuilderStatus;
  if (!["CANDIDATE_READY", "BLOCKED", "FAILED"].includes(status)) {
    throw new ControlError("RESULT_INVALID", `Unknown builder status ${status}`);
  }
  const sha = optionalString(body, "candidate_sha");
  if (status === "CANDIDATE_READY" && !sha) {
    throw new ControlError("RESULT_INVALID", "CANDIDATE_READY requires candidate_sha");
  }
  return {
    status,
    candidate_sha: sha,
    evidence_refs: requireStringArray(body, "evidence_refs"),
    notes: optionalString(body, "notes"),
  };
}

function parseFindings(raw: unknown): Finding[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ControlError("RESULT_INVALID", "findings must be an array");
  }
  return raw.map((item, i) => {
    if (!isRecord(item)) {
      throw new ControlError("RESULT_INVALID", `findings[${i}] invalid`);
    }
    return {
      finding_id: requireString(item, "finding_id"),
      severity: requireString(item, "severity"),
      summary: requireString(item, "summary"),
    };
  });
}

function parseReviewerResult(body: Record<string, unknown>): ReviewerResultBody {
  const verdict = requireString(body, "verdict") as ReviewerVerdict;
  if (!["PASS", "REWORK", "BLOCK"].includes(verdict)) {
    throw new ControlError("RESULT_INVALID", `Unknown verdict ${verdict}`);
  }
  return {
    target_sha: requireString(body, "target_sha"),
    verdict,
    findings: parseFindings(body.findings),
    evidence_refs: requireStringArray(body, "evidence_refs"),
  };
}

function parsePcDecisionKind(value: string): PcDecisionKind {
  if (
    !["BUILD", "REWORK", "ACCEPT", "RETRY", "REDESIGN", "HUMAN_GATE", "ABORT"].includes(
      value,
    )
  ) {
    throw new ControlError("RESULT_INVALID", `Unknown decision ${value}`);
  }
  return value as PcDecisionKind;
}

function parsePcDecision(body: Record<string, unknown>): PcDecisionBody {
  const decision = parsePcDecisionKind(requireString(body, "decision"));
  const findings = requireStringArray(body, "authorized_finding_ids");
  if (decision === "REWORK" && findings.length === 0) {
    throw new ControlError(
      "RESULT_INVALID",
      "REWORK decision must identify authorized finding IDs",
    );
  }
  let choices: PcDecisionKind[] | null = null;
  if (body.human_gate_choices != null) {
    if (!Array.isArray(body.human_gate_choices)) {
      throw new ControlError("RESULT_INVALID", "human_gate_choices must be an array");
    }
    choices = body.human_gate_choices.map((c) => parsePcDecisionKind(String(c)));
  }
  if (decision === "HUMAN_GATE" && (!choices || choices.length === 0)) {
    throw new ControlError("RESULT_INVALID", "HUMAN_GATE requires allowed choices");
  }
  return {
    decision,
    rationale: optionalString(body, "rationale"),
    authorized_finding_ids: findings,
    rework_scope: optionalString(body, "rework_scope"),
    human_gate_purpose: optionalString(body, "human_gate_purpose"),
    human_gate_choices: choices,
    install_policy: parsePolicyInstall(body.install_policy),
  };
}

function parsePolicyInstall(raw: unknown): PolicyInstall | null {
  if (raw == null) return null;
  if (!isRecord(raw)) {
    throw new ControlError("RESULT_INVALID", "install_policy must be an object");
  }
  const v = raw.on_builder_candidate;
  if (v !== "DISPATCH_REVIEW" && v !== "AWAIT_PC") {
    throw new ControlError("RESULT_INVALID", "Unknown install_policy.on_builder_candidate");
  }
  return { on_builder_candidate: v };
}

function parseHumanGate(body: Record<string, unknown>): HumanGateBody {
  const rawChoices = body.allowed_choices;
  if (!Array.isArray(rawChoices) || rawChoices.length === 0) {
    throw new ControlError("RESULT_INVALID", "Human Gate requires allowed_choices");
  }
  return {
    gate_id: requireString(body, "gate_id"),
    decision_envelope_id: requireString(body, "decision_envelope_id"),
    purpose: requireString(body, "purpose"),
    allowed_choices: rawChoices.map((c) => parsePcDecisionKind(String(c))),
  };
}

function parseHumanGateResponse(body: Record<string, unknown>): HumanGateResponseBody {
  return {
    gate_id: requireString(body, "gate_id"),
    selected_choice: parsePcDecisionKind(requireString(body, "selected_choice")),
    note: optionalString(body, "note"),
  };
}

export function parseCanonicalEnvelope(raw: unknown): CanonicalEnvelope {
  rejectForbiddenKeys(raw, "envelope");
  if (!isRecord(raw)) {
    throw new ControlError("RESULT_INVALID", "Envelope is not an object");
  }
  if (raw.protocol !== PROTOCOL_V1) {
    throw new ControlError("RESULT_INVALID", "Unsupported protocol");
  }
  const kind = requireString(raw, "kind") as EnvelopeKind;
  if (!KINDS.has(kind)) {
    throw new ControlError("RESULT_INVALID", `Unknown envelope kind ${kind}`);
  }
  const from = requireString(raw, "from_role") as LogicalRole;
  if (!ROLES.has(from)) {
    throw new ControlError("RESULT_INVALID", `Unknown from_role ${from}`);
  }
  let to: LogicalRole | null = null;
  if (raw.to_role != null) {
    to = requireString(raw, "to_role") as LogicalRole;
    if (!ROLES.has(to)) {
      throw new ControlError("RESULT_INVALID", `Unknown to_role ${to}`);
    }
  }
  if (!isRecord(raw.body)) {
    throw new ControlError("RESULT_INVALID", "Envelope body is required");
  }
  rejectForbiddenKeys(raw.body, "body");

  let body: EnvelopeBody;
  switch (kind) {
    case "control_request":
      body = parseControlRequest(raw.body);
      break;
    case "builder_result":
      body = parseBuilderResult(raw.body);
      break;
    case "reviewer_result":
      body = parseReviewerResult(raw.body);
      break;
    case "program_control_decision":
      body = parsePcDecision(raw.body);
      break;
    case "human_gate":
      body = parseHumanGate(raw.body);
      break;
    case "human_gate_response":
      body = parseHumanGateResponse(raw.body);
      break;
  }

  return {
    protocol: PROTOCOL_V1,
    envelope_id: requireString(raw, "envelope_id"),
    kind,
    cycle_id: requireString(raw, "cycle_id"),
    request_id: optionalString(raw, "request_id"),
    from_role: from,
    to_role: to,
    created_at: requireString(raw, "created_at"),
    body,
  };
}

export function parseCyclePolicy(raw: unknown): CyclePolicy {
  if (!isRecord(raw)) {
    throw new ControlError("RESULT_INVALID", "Cycle policy must be an object");
  }
  const v = raw.on_builder_candidate;
  if (v !== "DISPATCH_REVIEW" && v !== "AWAIT_PC") {
    throw new ControlError("RESULT_INVALID", "Unknown on_builder_candidate policy");
  }
  return { on_builder_candidate: v };
}

/** Stable identity serialization for envelope idempotency (all canonical fields). */
export function canonicalEnvelopeIdentity(env: CanonicalEnvelope): string {
  return JSON.stringify({
    protocol: env.protocol,
    envelope_id: env.envelope_id,
    kind: env.kind,
    cycle_id: env.cycle_id,
    request_id: env.request_id,
    from_role: env.from_role,
    to_role: env.to_role,
    created_at: env.created_at,
    body: env.body,
  });
}

export function missingCapabilities(
  required: Capability[],
  available: Capability[],
): Capability[] {
  const have = new Set(available);
  return required.filter((c) => !have.has(c));
}
