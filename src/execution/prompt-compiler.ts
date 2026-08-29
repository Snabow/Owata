import { createHash } from "node:crypto";
import type { CycleSnapshot } from "../control/adapters.js";
import type { CanonicalEnvelope, ControlRequestBody } from "../control/protocol.js";

export const COMPILER_TEMPLATE_VERSION = "builder-instruction-v1";

export interface CompileBuilderInstructionArgs {
  request: CanonicalEnvelope<ControlRequestBody>;
  cycle: CycleSnapshot;
  resultEnvelopeRelPath: string;
  workPackageRef?: string;
}

export interface CompiledBuilderInstruction {
  text: string;
  promptHash: string;
  templateVersion: typeof COMPILER_TEMPLATE_VERSION;
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

export function compileBuilderInstruction(
  args: CompileBuilderInstructionArgs,
): CompiledBuilderInstruction {
  const body = args.request.body;
  const canonical = {
    template_version: COMPILER_TEMPLATE_VERSION,
    cycle_id: args.cycle.cycle_id,
    request_id: args.request.request_id,
    action: body.action,
    work_package_ref: args.workPackageRef ?? args.cycle.work_package_ref,
    base_sha: body.base_sha ?? args.cycle.base_sha,
    target_sha: body.target_sha,
    authoritative_references: [...body.authoritative_references].sort(),
    stop_condition: body.stop_condition,
    expected_result_kind: body.expected_result_kind,
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
    "## Runtime Obligations",
    `- Write a canonical builder_result envelope JSON to: ${args.resultEnvelopeRelPath}`,
    "- Commit repository changes in the active worktree when producing CANDIDATE_READY.",
    "- Include resolvable candidate_sha when status is CANDIDATE_READY.",
  ].join("\n");

  const promptHash = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    text,
    promptHash,
    templateVersion: COMPILER_TEMPLATE_VERSION,
  };
}
