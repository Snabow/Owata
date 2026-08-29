import type { WorkRecord } from "../control/types.js";
import { ControlError } from "../control/types.js";

export interface ExecutionResult {
  ok: boolean;
  output: Record<string, unknown>;
}

export interface VerificationResult {
  status: "PASS" | "FAIL";
  detail: string;
}

export interface RepairResult {
  nextInput: Record<string, unknown>;
  note: string;
}

export interface TaskHandler {
  readonly taskType: string;
  execute(input: Record<string, unknown>): ExecutionResult;
  verify(
    input: Record<string, unknown>,
    execution: ExecutionResult,
  ): VerificationResult;
  /**
   * Return repaired durable input, or null if no repair is possible.
   * Must change the failing cause — not force verifier PASS.
   */
  repair(input: Record<string, unknown>): RepairResult | null;
}

/** Deterministic proving task: sum a+b, optional intentional defect via bug=true. */
export const sumTwoHandler: TaskHandler = {
  taskType: "sum_two",
  execute(input) {
    const a = Number(input.a);
    const b = Number(input.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { ok: false, output: { error: "invalid_operands" } };
    }
    const bug = Boolean(input.bug);
    const sum = bug ? a + b + 1 : a + b;
    return { ok: true, output: { sum, bug_applied: bug } };
  },
  verify(input, execution) {
    if (!execution.ok) {
      return { status: "FAIL", detail: "execution_not_ok" };
    }
    const expected = Number(input.expected);
    const sum = Number(execution.output.sum);
    if (!Number.isFinite(expected) || !Number.isFinite(sum)) {
      return { status: "FAIL", detail: "non_numeric" };
    }
    if (sum !== expected) {
      return {
        status: "FAIL",
        detail: `sum ${sum} !== expected ${expected}`,
      };
    }
    return { status: "PASS", detail: "sum_matches_expected" };
  },
  repair(input) {
    if (!Boolean(input.bug)) {
      return null;
    }
    return {
      nextInput: { ...input, bug: false },
      note: "cleared intentional bug flag",
    };
  },
};

const handlers = new Map<string, TaskHandler>([
  [sumTwoHandler.taskType, sumTwoHandler],
]);

export function registerTaskHandler(handler: TaskHandler): void {
  handlers.set(handler.taskType, handler);
}

export function unregisterTaskHandler(taskType: string): void {
  handlers.delete(taskType);
}

export function getTaskHandler(taskType: string): TaskHandler {
  const handler = handlers.get(taskType);
  if (!handler) {
    throw new ControlError("UNKNOWN_TASK", `Unknown task_type: ${taskType}`);
  }
  return handler;
}

export function requireExecutableWork(work: WorkRecord): {
  taskType: string;
  taskInput: Record<string, unknown>;
} {
  if (!work.task_type || !work.task_input) {
    throw new ControlError(
      "NO_EXEC_SPEC",
      `Work ${work.work_id} has no durable execution spec`,
    );
  }
  return { taskType: work.task_type, taskInput: work.task_input };
}
