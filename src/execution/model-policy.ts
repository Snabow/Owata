import { ControlError } from "../control/types.js";

const CLAUDE_SUBSTRINGS = [
  "claude",
  "anthropic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
] as const;

export function isClaudeFamily(id: string): boolean {
  const lower = id.toLowerCase();
  return CLAUDE_SUBSTRINGS.some((part) => lower.includes(part));
}

export function isAutoRouter(id: string): boolean {
  const lower = id.toLowerCase();
  return lower === "auto" || /\bauto\b/.test(lower);
}

export function assertNonClaudeModel(id: string): void {
  if (isClaudeFamily(id)) {
    throw new ControlError(
      "NON_CLAUDE_BINDING_UNAVAILABLE",
      `Model "${id}" is Claude-family and rejected by execution policy`,
    );
  }
  if (isAutoRouter(id)) {
    throw new ControlError(
      "NON_CLAUDE_BINDING_UNAVAILABLE",
      `Model "${id}" is auto-router and rejected by execution policy`,
    );
  }
}
