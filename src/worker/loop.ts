import type { ControlStore } from "../control/store.js";
import { ControlError } from "../control/types.js";
import type { AttemptRecord, WorkRecord } from "../control/types.js";
import { getTaskHandler, requireExecutableWork } from "./tasks.js";
import type { RepairResult, TaskHandler } from "./tasks.js";

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

function isStaleLease(err: unknown): boolean {
  return err instanceof ControlError && err.code === "STALE_LEASE";
}

/**
 * Terminalize under current lease. Never converts STALE_LEASE into a mutation.
 */
function failUnderLease(
  store: ControlStore,
  workId: string,
  leaseToken: string,
  workerId: string,
  failureReason: string,
  resultReason: string,
  now: Date,
): WorkerRunResult {
  try {
    const failed = store.failWork(
      workId,
      leaseToken,
      workerId,
      failureReason,
      now,
    );
    return {
      work: failed,
      completed: false,
      failed: true,
      attempts: store.listAttempts(workId),
      reason: resultReason,
    };
  } catch (err) {
    if (isStaleLease(err)) throw err;
    throw err;
  }
}

function readRepairResult(repair: RepairResult): {
  nextInput: Record<string, unknown>;
  note: string;
} {
  const nextInput = repair.nextInput;
  const note = repair.note;
  if (
    nextInput == null ||
    typeof nextInput !== "object" ||
    Array.isArray(nextInput)
  ) {
    throw new ControlError("REPAIR_RESULT", "invalid repair nextInput");
  }
  if (typeof note !== "string") {
    throw new ControlError("REPAIR_RESULT", "invalid repair note");
  }
  return { nextInput, note };
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
      return failUnderLease(
        store,
        current.work_id,
        leaseToken,
        workerId,
        `setup_error:${sanitizeError(err)}`,
        "setup_error",
        now(),
      );
    }

    let executionOk: boolean | null = null;
    let executionResult: Record<string, unknown> | null = null;

    store.recordExecutionStarted(
      current.work_id,
      leaseToken,
      workerId,
      attempt.attempt_id,
      now(),
    );

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
      return failUnderLease(
        store,
        current.work_id,
        leaseToken,
        workerId,
        `execution_error:${sanitizeError(err)}`,
        "execution_error",
        now(),
      );
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
      return failUnderLease(
        store,
        current.work_id,
        leaseToken,
        workerId,
        `verification_error:${sanitizeError(err)}`,
        "verification_error",
        now(),
      );
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
      return failUnderLease(
        store,
        current.work_id,
        leaseToken,
        workerId,
        "completion_gate:verification_pass_without_execution_ok",
        "completion_gate_rejected",
        now(),
      );
    }

    // Verification FAIL — may repair if budget remains.
    const latest = store.getWork(current.work_id)!;
    if (latest.repair_count >= latest.max_repairs) {
      return failUnderLease(
        store,
        current.work_id,
        leaseToken,
        workerId,
        "repair_budget_exhausted",
        "repair_budget_exhausted",
        now(),
      );
    }

    // Obtain + validate + apply repair; terminalize non-fencing failures (IR-009).
    try {
      const repair = handler.repair(taskInput);
      if (!repair) {
        return failUnderLease(
          store,
          current.work_id,
          leaseToken,
          workerId,
          "no_repair_available",
          "no_repair_available",
          now(),
        );
      }
      const { nextInput, note } = readRepairResult(repair);
      store.applyRepair(
        {
          workId: current.work_id,
          leaseToken,
          workerId,
          attemptId: finished.attempt_id,
          nextInput,
          note,
        },
        now(),
      );
    } catch (err) {
      if (isStaleLease(err)) throw err;
      return failUnderLease(
        store,
        current.work_id,
        leaseToken,
        workerId,
        `repair_error:${sanitizeError(err)}`,
        "repair_error",
        now(),
      );
    }
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
