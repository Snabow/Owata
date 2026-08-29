import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNonClaudeModel,
  isAutoRouter,
  isClaudeFamily,
} from "./model-policy.js";
import { ControlError } from "../control/types.js";

test("isClaudeFamily detects claude-family substrings case-insensitively", () => {
  assert.equal(isClaudeFamily("claude-3-opus"), true);
  assert.equal(isClaudeFamily("Anthropic-Sonnet"), true);
  assert.equal(isClaudeFamily("cursor-grok-4.6"), false);
});

test("isAutoRouter detects auto router ids", () => {
  assert.equal(isAutoRouter("auto"), true);
  assert.equal(isAutoRouter("Auto"), true);
  assert.equal(isAutoRouter("gpt-5.6-sol"), false);
});

test("assertNonClaudeModel rejects claude and auto", () => {
  assert.throws(
    () => assertNonClaudeModel("claude-sonnet-4"),
    (err: unknown) =>
      err instanceof ControlError && err.code === "NON_CLAUDE_BINDING_UNAVAILABLE",
  );
  assert.throws(
    () => assertNonClaudeModel("auto"),
    (err: unknown) =>
      err instanceof ControlError && err.code === "NON_CLAUDE_BINDING_UNAVAILABLE",
  );
  assert.doesNotThrow(() => assertNonClaudeModel("gpt-5.6-sol"));
});
