import type { ControlStore } from "../control/store.js";
import { ControlError } from "../control/types.js";
import type { AttemptRecord, WorkRecord } from "../control/types.js";
import { getTaskHandler, requireExecutableWork } from "./tasks.js";
import type { TaskHandler } from "./tasks.js";

export interface WorkerRunResult {
  work: WorkRecord;
  completed: boolean;
  failed: boolean;
  attempts: AttemptRecord[];
  reason?: string;
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

/**
 * Production single-worker completion loop for one claimed work item.
 * At-least-once execution: retries after repair are intentional and idempotent
 * for the deterministic local sample handlers.
 */
export function runOwnedWork(
  store: ControlStore,
  work: WorkRecord,
  options?: { now?: Date },
): WorkerRunResult {
  if (!work.lease_token || !work.lease_owner) {
    throw new ControlError("INVALID", "Work is not lease-owned");
  }
  const workerId = work.lease_owner;
  const leaseToken = work.lease_token;
  const now = () => options?.now ?? new Date();

  for (;;) {
    store.assertActiveLease(work.work_id, leaseToken, workerId, now());
    const current = store.getWork(work.work_id);
    if (!current) {
      throw new ControlError("NOT_FOUND", "Work disappeared");
    }

    // Preparation is part of the durable attempt (WP002-IR-007).
    const attempt = store.beginExecutionAttempt(
      current.work_id,
      leaseToken,
      workerId,
      now(),
    );

    let taskInput: Record<string, unknown>;
    let handler: TaskHandler;
    try {
      const resolved = requireExecutableWork(current);
      taskInput = resolved.taskInput;
      handler = getTaskHandler(resolved.taskType);
    } catch (err) {
      store.finalizeAttemptError(
        {
          workId: current.work_id,
          leaseToken,
          workerId,
          attemptId: attempt.attempt_id,
          outcome: "SETUP_ERROR",
          executionOk: null,
          result: null,
          detail: sanitizeError(err),
        },
        now(),
      );
      const failed = store.failWork(
        current.work_id,
        leaseToken,
        workerId,
        `setup_error:${sanitizeError(err)}`,
        now(),
      );
      return {
        work: failed,
        completed: false,
        failed: true,
        attempts: store.listAttempts(current.work_id),
        reason: "setup_error",
      };
    }

    let executionOk: boolean | null = null;
    let executionResult: Record<string, unknown> | null = null;

    try {
      const execution = handler.execute(taskInput);
      executionOk = execution.ok;
      executionResult = execution.output;
    } catch (err) {
      store.finalizeAttemptError(
        {
          workId: current.work_id,
          leaseToken,
          workerId,
          attemptId: attempt.attempt_id,
          outcome: "EXEC_ERROR",
          executionOk: null,
          result: null,
          detail: sanitizeError(err),
        },
        now(),
      );
      const failed = store.failWork(
        current.work_id,
        leaseToken,
        workerId,
        `execution_error:${sanitizeError(err)}`,
        now(),
      );
      return {
        work: failed,
        completed: false,
        failed: true,
        attempts: store.listAttempts(current.work_id),
        reason: "execution_error",
      };
    }

    let verificationStatus: "PASS" | "FAIL";
    let verificationDetail: string;
    try {
      const verification = handler.verify(taskInput, {
        ok: executionOk === true,
        output: executionResult ?? {},
      });
      verificationStatus = verification.status;
      verificationDetail = verification.detail;
    } catch (err) {
      store.finalizeAttemptError(
        {
          workId: current.work_id,
          leaseToken,
          workerId,
          attemptId: attempt.attempt_id,
          outcome: "VERIFY_ERROR",
          executionOk,
          result: executionResult,
          detail: sanitizeError(err),
        },
        now(),
      );
      const failed = store.failWork(
        current.work_id,
        leaseToken,
        workerId,
        `verification_error:${sanitizeError(err)}`,
        now(),
      );
      return {
        work: failed,
        completed: false,
        failed: true,
        attempts: store.listAttempts(current.work_id),
        reason: "verification_error",
      };
    }

    const finished = store.finishExecutionAttempt(
      {
        workId: current.work_id,
        leaseToken,
        workerId,
        attemptId: attempt.attempt_id,
        executionOk: executionOk === true,
        result: executionResult ?? {},
        verificationStatus,
        verificationDetail,
      },
      now(),
    );

    // Completion gate: both execution success AND verification PASS.
    if (
      finished.execution_ok === true &&
      finished.verification_status === "PASS" &&
      finished.attempt_outcome === "PASS"
    ) {
      const completed = store.completeWork(
        current.work_id,
        leaseToken,
        workerId,
        now(),
      );
      return {
        work: completed,
        completed: true,
        failed: false,
        attempts: store.listAttempts(current.work_id),
      };
    }

    // verification PASS with execution failure → terminal FAILED (not COMPLETED)
    if (
      finished.verification_status === "PASS" &&
      finished.execution_ok !== true
    ) {
      const failed = store.failWork(
        current.work_id,
        leaseToken,
        workerId,
        "completion_gate:verification_pass_without_execution_ok",
        now(),
      );
      return {
        work: failed,
        completed: false,
        failed: true,
        attempts: store.listAttempts(current.work_id),
        reason: "completion_gate_rejected",
      };
    }

    // Verification FAIL — may repair if budget remains.
    const latest = store.getWork(current.work_id)!;
    if (latest.repair_count >= latest.max_repairs) {
      const failed = store.failWork(
        current.work_id,
        leaseToken,
        workerId,
        "repair_budget_exhausted",
        now(),
      );
      return {
        work: failed,
        completed: false,
        failed: true,
        attempts: store.listAttempts(current.work_id),
        reason: "repair_budget_exhausted",
      };
    }

    let repair;
    try {
      repair = handler.repair(taskInput);
    } catch (err) {
      // Preserve finished FAIL attempt; do not increment repair_count.
      const failed = store.failWork(
        current.work_id,
        leaseToken,
        workerId,
        `repair_error:${sanitizeError(err)}`,
        now(),
      );
      return {
        work: failed,
        completed: false,
        failed: true,
        attempts: store.listAttempts(current.work_id),
        reason: "repair_error",
      };
    }

    if (!repair) {
      const failed = store.failWork(
        current.work_id,
        leaseToken,
        workerId,
        "no_repair_available",
        now(),
      );
      return {
        work: failed,
        completed: false,
        failed: true,
        attempts: store.listAttempts(current.work_id),
        reason: "no_repair_available",
      };
    }

    store.applyRepair(
      {
        workId: current.work_id,
        leaseToken,
        workerId,
        attemptId: finished.attempt_id,
        nextInput: repair.nextInput,
        note: repair.note,
      },
      now(),
    );
  }
}

/**
 * Claim next QUEUED work and run the completion loop once.
 */
export function runOnce(
  store: ControlStore,
  workerId: string,
  leaseDurationMs: number,
  options?: { now?: Date },
): WorkerRunResult | null {
  store.recoverExpiredLeases(options?.now);
  const claimed = store.claimNextWork(
    workerId,
    leaseDurationMs,
    options?.now,
  );
  if (!claimed) {
    return null;
  }
  return runOwnedWork(store, claimed, options);
}
