import { createHash } from "node:crypto";
import type { CycleSnapshot } from "../control/adapters.js";
import type {
  CanonicalEnvelope,
  ControlRequestBody,
} from "../control/protocol.js";

export const PROGRAM_CONTROL_COMPILER_TEMPLATE_VERSION =
  "program-control-instruction-v1";

export interface CompileProgramControlInstructionArgs {
  request: CanonicalEnvelope<ControlRequestBody>;
  cycle: CycleSnapshot;
  envelopes: CanonicalEnvelope[];
  resultEnvelopeRelPath: string;
  workPackageRef?: string;
}

export interface CompiledProgramControlInstruction {
  text: string;
  promptHash: string;
  templateVersion: typeof PROGRAM_CONTROL_COMPILER_TEMPLATE_VERSION;
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
 * Compile Program Control instruction deterministically from durable canonical
 * state. Authority-bearing field changes MUST change prompt hash.
 * Do not invent findings, paraphrase scope, or embed credentials.
 */
export function compileProgramControlInstruction(
  args: CompileProgramControlInstructionArgs,
): CompiledProgramControlInstruction {
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

  const cycleSnapshot = {
    cycle_id: args.cycle.cycle_id,
    state: args.cycle.state,
    work_package_ref: args.cycle.work_package_ref,
    base_sha: args.cycle.base_sha,
    latest_candidate_sha: args.cycle.latest_candidate_sha,
    accepted_candidate_sha: args.cycle.accepted_candidate_sha,
    current_request_id: args.cycle.current_request_id,
    policy: args.cycle.policy,
    policy_authorized_by_decision_id: args.cycle.policy_authorized_by_decision_id,
    recovery_target_request_id: args.cycle.recovery_target_request_id,
    recovery_lineage_id: args.cycle.recovery_lineage_id,
    recovery_reason: args.cycle.recovery_reason,
  };

  const durableEnvelopes = args.envelopes
    .filter((e) => e.cycle_id === args.cycle.cycle_id)
    .map((e) => ({
      envelope_id: e.envelope_id,
      kind: e.kind,
      cycle_id: e.cycle_id,
      request_id: e.request_id,
      from_role: e.from_role,
      to_role: e.to_role,
      created_at: e.created_at,
      body: e.body,
    }));

  const canonical = {
    template_version: PROGRAM_CONTROL_COMPILER_TEMPLATE_VERSION,
    cycle_id: args.cycle.cycle_id,
    request_id: args.request.request_id,
    request_body: requestBody,
    cycle: cycleSnapshot,
    durable_envelopes: durableEnvelopes,
    result_envelope_path: args.resultEnvelopeRelPath,
  };

  const text = [
    "# Program Control Instruction",
    "",
    "ROLE: Program Control",
    "AUTHORITY: Sole adjudicator of Reviewer findings and next-action decisions.",
    "TRUST_DOMAIN: Separate from Builder and Independent Reviewer sessions.",
    "",
    "YOU MUST:",
    "- Decide solely from the durable cycle snapshot and envelopes below",
    "- Return exactly one program_control_decision envelope",
    "- For REWORK: authorize only finding IDs present on the latest Reviewer REWORK for the exact latest candidate",
    "- For ACCEPT: require latest Reviewer PASS for the exact latest candidate with no newer candidate and no unresolved REWORK/BLOCK",
    "",
    "YOU MUST NOT:",
    "- Implement code or act as Builder",
    "- Act as Independent Reviewer",
    "- Invent findings or invent authorized_finding_ids",
    "- Suppress Reviewer findings",
    "- Use Browser Relay or chat history as authority",
    "- Modify repository tracked files or create commits",
    "",
    "## Canonical Control Request + Durable State",
    stableStringify(canonical),
    "",
    "## program_control_decision contract",
    "Write JSON matching:",
    "{",
    '  "protocol": "owata.handoff/1",',
    '  "envelope_id": "<unique>",',
    '  "kind": "program_control_decision",',
    `  "cycle_id": ${JSON.stringify(args.cycle.cycle_id)},`,
    `  "request_id": ${JSON.stringify(args.request.request_id)},`,
    '  "from_role": "program_control",',
    '  "to_role": "dispatcher",',
    '  "created_at": "<ISO-8601>",',
    "  \"body\": {",
    '    "decision": "BUILD" | "REWORK" | "ACCEPT" | "RETRY" | "REDESIGN" | "HUMAN_GATE" | "ABORT",',
    '    "rationale": string | null,',
    '    "authorized_finding_ids": string[],',
    '    "rework_scope": string | null,',
    '    "human_gate_purpose": string | null,',
    '    "human_gate_choices": string[] | null,',
    '    "install_policy": { "on_builder_candidate": "DISPATCH_REVIEW" | "AWAIT_PC" } | null',
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
    templateVersion: PROGRAM_CONTROL_COMPILER_TEMPLATE_VERSION,
  };
}
