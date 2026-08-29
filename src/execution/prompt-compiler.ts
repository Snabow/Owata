import { createHash } from "node:crypto";
import type { CycleSnapshot } from "../control/adapters.js";
import { ControlError } from "../control/types.js";
import type {
  CanonicalEnvelope,
  ControlRequestBody,
  Finding,
  PcDecisionBody,
  ReviewerResultBody,
} from "../control/protocol.js";

export const COMPILER_TEMPLATE_VERSION = "builder-instruction-v1";

export interface CompileBuilderInstructionArgs {
  request: CanonicalEnvelope<ControlRequestBody>;
  cycle: CycleSnapshot;
  resultEnvelopeRelPath: string;
  workPackageRef?: string;
  /** Durable cycle envelopes used to resolve authorized decision/findings. */
  envelopes?: CanonicalEnvelope[];
}

export interface ResolvedAuthorization {
  decision: {
    envelope_id: string;
    decision: string;
    rationale: string | null;
    authorized_finding_ids: string[];
    rework_scope: string | null;
  } | null;
  findings: Finding[];
}

export interface CompiledBuilderInstruction {
  text: string;
  promptHash: string;
  templateVersion: typeof COMPILER_TEMPLATE_VERSION;
  resolvedAuthorization: ResolvedAuthorization;
}

function stableStringify(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * Resolve authorized decision + findings exclusively from durable envelopes.
 * Fail closed on missing/mismatched authority; never invent or paraphrase.
 */
export function resolveAuthorizedContext(
  request: CanonicalEnvelope<ControlRequestBody>,
  envelopes: CanonicalEnvelope[],
): ResolvedAuthorization {
  const body = request.body;
  let decision: ResolvedAuthorization["decision"] = null;

  if (body.authorized_by_decision_id) {
    const env = envelopes.find(
      (e) =>
        e.envelope_id === body.authorized_by_decision_id &&
        e.kind === "program_control_decision",
    );
    if (!env) {
      throw new ControlError(
        "RESULT_INVALID",
        `authorized_by_decision_id unresolved: ${body.authorized_by_decision_id}`,
      );
    }
    if (env.cycle_id !== request.cycle_id) {
      throw new ControlError(
        "RESULT_INVALID",
        `authorized_by_decision_id cycle mismatch: ${body.authorized_by_decision_id}`,
      );
    }
    const d = env.body as PcDecisionBody;
    decision = {
      envelope_id: env.envelope_id,
      decision: d.decision,
      rationale: d.rationale,
      authorized_finding_ids: [...d.authorized_finding_ids].sort(),
      rework_scope: d.rework_scope,
    };
  }

  const findings: Finding[] = [];
  for (const findingId of body.authorized_finding_ids) {
    let found: Finding | undefined;
    for (const env of envelopes) {
      if (env.kind !== "reviewer_result") continue;
      if (env.cycle_id !== request.cycle_id) continue;
      const rb = env.body as ReviewerResultBody;
      found = rb.findings.find((f) => f.finding_id === findingId);
      if (found) break;
    }
    if (!found) {
      throw new ControlError(
        "RESULT_INVALID",
        `authorized_finding_id unresolved: ${findingId}`,
      );
    }
    findings.push({
      finding_id: found.finding_id,
      severity: found.severity,
      summary: found.summary,
    });
  }
  findings.sort((a, b) => a.finding_id.localeCompare(b.finding_id));
  return { decision, findings };
}

export function compileBuilderInstruction(
  args: CompileBuilderInstructionArgs,
): CompiledBuilderInstruction {
  const body = args.request.body;
  const envelopes = args.envelopes ?? [];
  const resolvedAuthorization = resolveAuthorizedContext(args.request, envelopes);

  // Complete canonical Control Request body + resolved authorization.
  // Do not maintain a fragile manually selected subset of authority fields.
  const requestBody = {
    action: body.action,
    target_role: body.target_role,
    work_package_ref: args.workPackageRef ?? body.work_package_ref,
    base_sha: body.base_sha ?? args.cycle.base_sha,
    target_sha: body.target_sha,
    authoritative_references: [...body.authoritative_references].sort(),
    required_capabilities: [...body.required_capabilities].sort(),
    expected_result_kind: body.expected_result_kind,
    stop_condition: body.stop_condition,
    authorized_by_decision_id: body.authorized_by_decision_id,
    authorized_finding_ids: [...body.authorized_finding_ids].sort(),
    retry_of_request_id: body.retry_of_request_id,
  };

  const canonical = {
    template_version: COMPILER_TEMPLATE_VERSION,
    cycle_id: args.cycle.cycle_id,
    request_id: args.request.request_id,
    request_body: requestBody,
    resolved_authorization: resolvedAuthorization,
    result_envelope_path: args.resultEnvelopeRelPath,
  };

  const text = [
    "# Builder Instruction",
    "",
    "Execute the canonical control request below. Do not paraphrase findings or invent scope.",
    "",
    "## Canonical Request",
    stableStringify(canonical),
    "",
    "## Resolved Authorization (durable envelopes only)",
    stableStringify(resolvedAuthorization),
    "",
    "## Runtime Obligations",
    `- Write a canonical builder_result envelope JSON to: ${args.resultEnvelopeRelPath}`,
    "- Commit repository changes in the active worktree when producing CANDIDATE_READY.",
    "- Include resolvable candidate_sha (git rev-parse HEAD after commit) when status is CANDIDATE_READY.",
    "- If CANARY_TASK.md exists at the worktree root, execute that file verbatim as the bounded task; do not expand scope beyond it and the envelope obligation.",
  ].join("\n");

  const promptHash = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    text,
    promptHash,
    templateVersion: COMPILER_TEMPLATE_VERSION,
    resolvedAuthorization,
  };
}
