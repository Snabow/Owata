import { createHash } from "node:crypto";
import type { CycleSnapshot } from "../control/adapters.js";
import type {
  CanonicalEnvelope,
  ControlRequestBody,
} from "../control/protocol.js";

export const REVIEWER_COMPILER_TEMPLATE_VERSION = "reviewer-instruction-v1";

export interface CompileReviewerInstructionArgs {
  request: CanonicalEnvelope<ControlRequestBody>;
  cycle: CycleSnapshot;
  resultEnvelopeRelPath: string;
  workPackageRef?: string;
}

export interface CompiledReviewerInstruction {
  text: string;
  promptHash: string;
  templateVersion: typeof REVIEWER_COMPILER_TEMPLATE_VERSION;
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
 * Compile Independent Reviewer instruction deterministically from durable
 * canonical state. Authority-bearing field changes MUST change prompt hash.
 * Do not invent findings, paraphrase scope, or embed credentials.
 */
export function compileReviewerInstruction(
  args: CompileReviewerInstructionArgs,
): CompiledReviewerInstruction {
  const body = args.request.body;

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
    template_version: REVIEWER_COMPILER_TEMPLATE_VERSION,
    cycle_id: args.cycle.cycle_id,
    request_id: args.request.request_id,
    request_body: requestBody,
    result_envelope_path: args.resultEnvelopeRelPath,
  };

  const text = [
    "# Independent Reviewer Instruction",
    "",
    "ROLE: Independent Reviewer",
    "AUTHORITY: Program Control receives and adjudicates all findings.",
    "TRUST_DOMAIN: Independent from Builder. No Builder chat/history.",
    "",
    "YOU MUST:",
    "- Review exact target_sha from the canonical request below",
    "- Inspect repository artifacts at that SHA only",
    "- Return PASS / REWORK / BLOCK with concrete findings",
    "- Write a canonical reviewer_result envelope JSON to the result path",
    "",
    "YOU MUST NOT:",
    "- Modify source / tracked files",
    "- Create commits",
    "- Repair findings",
    "- Instruct Builder directly",
    "- Decide next project action",
    "- Suppress findings",
    "- Invent findings not grounded in the candidate",
    "",
    "## Canonical Control Request",
    stableStringify(canonical),
    "",
    "## reviewer_result contract",
    "Write JSON matching:",
    "{",
    '  "protocol": "owata.handoff/1",',
    '  "envelope_id": "<unique>",',
    '  "kind": "reviewer_result",',
    `  "cycle_id": ${JSON.stringify(args.cycle.cycle_id)},`,
    `  "request_id": ${JSON.stringify(args.request.request_id)},`,
    '  "from_role": "reviewer",',
    '  "to_role": "program_control",',
    '  "created_at": "<ISO-8601>",',
    "  \"body\": {",
    `    "target_sha": ${JSON.stringify(body.target_sha)},`,
    '    "verdict": "PASS" | "REWORK" | "BLOCK",',
    '    "findings": [{ "finding_id": "...", "severity": "...", "summary": "..." }],',
    '    "evidence_refs": []',
    "  }",
    "}",
    "",
    `Write the envelope JSON to: ${args.resultEnvelopeRelPath}`,
    "Do not modify any repository tracked files.",
  ].join("\n");

  const promptHash = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    text,
    promptHash,
    templateVersion: REVIEWER_COMPILER_TEMPLATE_VERSION,
  };
}
