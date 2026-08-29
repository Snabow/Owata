import type { ControlStore } from "../control/store.js";
import { ControlError } from "../control/types.js";
import type { AttemptRecord, WorkRecord } from "../control/types.js";
import { getTaskHandler, requireExecutableWork } from "./tasks.js";

export interface WorkerRunResult {
  work: WorkRecord;
  completed: boolean;
  attempts: AttemptRecord[];
  reason?: string;
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
    const { taskType, taskInput } = requireExecutableWork(current);
    const handler = getTaskHandler(taskType);

    const attempt = store.beginExecutionAttempt(
      current.work_id,
      leaseToken,
      workerId,
      now(),
    );
    const execution = handler.execute(taskInput);
    const verification = handler.verify(taskInput, execution);

    store.finishExecutionAttempt(
      {
        workId: current.work_id,
        leaseToken,
        workerId,
        attemptId: attempt.attempt_id,
        executionOk: execution.ok,
        result: execution.output,
        verificationStatus: verification.status,
        verificationDetail: verification.detail,
      },
      now(),
    );

    if (verification.status === "PASS") {
      const completed = store.completeWork(
        current.work_id,
        leaseToken,
        workerId,
        now(),
      );
      return {
        work: completed,
        completed: true,
        attempts: store.listAttempts(current.work_id),
      };
    }

    // Verification FAIL — never complete on execution success alone.
    if (current.repair_count >= current.max_repairs) {
      return {
        work: store.getWork(current.work_id)!,
        completed: false,
        attempts: store.listAttempts(current.work_id),
        reason: "repair_budget_exhausted",
      };
    }

    const repair = handler.repair(taskInput);
    if (!repair) {
      return {
        work: store.getWork(current.work_id)!,
        completed: false,
        attempts: store.listAttempts(current.work_id),
        reason: "no_repair_available",
      };
    }

    store.applyRepair(
      {
        workId: current.work_id,
        leaseToken,
        workerId,
        nextInput: repair.nextInput,
        note: repair.note,
      },
      now(),
    );
    // Continue loop for a new execution attempt under the same lease.
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
