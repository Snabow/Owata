import assert from "node:assert/strict";
import test from "node:test";
import {
  B2FullCanaryInvocationBudget,
  B2_S2_CANARY_BUDGET,
} from "./b2-full-invocation-budget.js";
import { ControlError } from "../control/types.js";

test("F03 canary budget allows exact 3/2/2 total 7", () => {
  const b = new B2FullCanaryInvocationBudget();
  b.consume("program_control");
  b.consume("builder");
  b.consume("reviewer");
  b.consume("program_control");
  b.consume("builder");
  b.consume("reviewer");
  b.consume("program_control");
  assert.deepEqual(b.snapshot(), {
    program_control: 3,
    builder: 2,
    reviewer: 2,
    total: 7,
  });
});

test("F03 canary budget blocks 4th PC before spawn", () => {
  const b = new B2FullCanaryInvocationBudget();
  for (let i = 0; i < B2_S2_CANARY_BUDGET.PC_MAX; i += 1) {
    b.consume("program_control");
  }
  assert.throws(
    () => b.consume("program_control"),
    (err: unknown) =>
      err instanceof ControlError &&
      err.code === "CANARY_INVOCATION_BUDGET_EXCEEDED",
  );
});

test("F03 canary budget blocks total>7 before spawn", () => {
  const b = new B2FullCanaryInvocationBudget();
  // Fill to 6 with role-legal mix, then one more should be ok to 7,
  // then any 8th fails.
  b.consume("program_control");
  b.consume("program_control");
  b.consume("program_control");
  b.consume("builder");
  b.consume("builder");
  b.consume("reviewer");
  b.consume("reviewer"); // total 7
  assert.throws(
    () => b.consume("program_control"),
    (err: unknown) =>
      err instanceof ControlError &&
      err.code === "CANARY_INVOCATION_BUDGET_EXCEEDED",
  );
});
