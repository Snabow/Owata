import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { ensureStateDirectory } from "../state-directory.js";
import {
  eventsJsonlPath,
  getSchemaVersion,
  isSqliteBusy,
  openDatabase,
  sleepMs,
  verifyWalMode,
} from "./db.js";
import { newId, nowIso } from "./ids.js";
import {
  ControlError,
  type AttemptOutcome,
  type AttemptRecord,
  type EventRecord,
  type EventType,
  type ProjectRecord,
  type ProjectState,
  type VerificationStatus,
  type WorkRecord,
  type WorkState,
} from "./types.js";

export interface ControlStoreOptions {
  stateDir: string;
  clock?: () => Date;
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    project_id: String(row.project_id),
    name: String(row.name),
    state: String(row.state) as ProjectState,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapWork(row: Record<string, unknown>): WorkRecord {
  let taskInput: Record<string, unknown> | null = null;
  if (row.task_input != null && String(row.task_input).length > 0) {
    taskInput = JSON.parse(String(row.task_input)) as Record<string, unknown>;
  }
  return {
    work_id: String(row.work_id),
    project_id: String(row.project_id),
    title: String(row.title),
    state: String(row.state) as WorkState,
    attempt: Number(row.attempt),
    lease_owner: row.lease_owner == null ? null : String(row.lease_owner),
    lease_token: row.lease_token == null ? null : String(row.lease_token),
    lease_expires_at:
      row.lease_expires_at == null ? null : String(row.lease_expires_at),
    task_type: row.task_type == null ? null : String(row.task_type),
    task_input: taskInput,
    repair_count: Number(row.repair_count ?? 0),
    max_repairs: Number(row.max_repairs ?? 1),
    failure_reason:
      row.failure_reason == null ? null : String(row.failure_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapAttempt(row: Record<string, unknown>): AttemptRecord {
  return {
    attempt_id: String(row.attempt_id),
    work_id: String(row.work_id),
    attempt_number: Number(row.attempt_number),
    worker_id: String(row.worker_id),
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    execution_ok:
      row.execution_ok == null ? null : Number(row.execution_ok) === 1,
    result_json:
      row.result_json == null || String(row.result_json).length === 0
        ? null
        : (JSON.parse(String(row.result_json)) as Record<string, unknown>),
    verification_status:
      row.verification_status == null
        ? null
        : (String(row.verification_status) as VerificationStatus),
    verification_detail:
      row.verification_detail == null
        ? null
        : String(row.verification_detail),
    attempt_outcome:
      row.attempt_outcome == null
        ? null
        : (String(row.attempt_outcome) as AttemptOutcome),
    repair_applied: Number(row.repair_applied ?? 0) === 1,
    repair_note: row.repair_note == null ? null : String(row.repair_note),
    created_at: String(row.created_at),
  };
}

function mapEvent(row: Record<string, unknown>): EventRecord {
  return {
    event_id: String(row.event_id),
    ts: String(row.ts),
    event_type: String(row.event_type) as EventType,
    project_id: row.project_id == null ? null : String(row.project_id),
    work_id: row.work_id == null ? null : String(row.work_id),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    jsonl_flushed: Number(row.jsonl_flushed),
  };
}

export class ControlStore {
  readonly stateDir: string;
  readonly db: DatabaseSync;
  private readonly clock: () => Date;
  private closed = false;

  private constructor(stateDir: string, db: DatabaseSync, clock: () => Date) {
    this.stateDir = stateDir;
    this.db = db;
    this.clock = clock;
  }

  static open(options: ControlStoreOptions): ControlStore {
    if (!ensureStateDirectory(options.stateDir)) {
      throw new ControlError(
        "STATE_DIR",
        `State directory is not usable: ${options.stateDir}`,
      );
    }
    const db = openDatabase(options.stateDir);
    if (!verifyWalMode(db)) {
      db.close();
      throw new ControlError("WAL", "Failed to enable SQLite WAL mode");
    }
    const store = new ControlStore(
      options.stateDir,
      db,
      options.clock ?? (() => new Date()),
    );
    store.flushEventJsonl();
    return store;
  }

  schemaVersion(): number {
    return getSchemaVersion(this.db);
  }

  walEnabled(): boolean {
    return verifyWalMode(this.db);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private withTransaction<T>(fn: () => T): T {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        break;
      } catch (err) {
        if (!isSqliteBusy(err) || Date.now() >= deadline) {
          throw err;
        }
        sleepMs(10);
      }
    }

    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors after a failed transaction
      }
      throw err;
    }
  }

  createProject(name: string, state: ProjectState = "ACTIVE"): ProjectRecord {
    const ts = nowIso(this.clock);
    const project: ProjectRecord = {
      project_id: newId("prj"),
      name,
      state,
      created_at: ts,
      updated_at: ts,
    };

    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (project_id, name, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          project.project_id,
          project.name,
          project.state,
          project.created_at,
          project.updated_at,
        );
      this.insertEvent("project.created", {
        project_id: project.project_id,
        work_id: null,
        payload: { name: project.name, state: project.state },
        ts,
      });
    });
    this.flushEventJsonl();
    return project;
  }

  getProject(projectId: string): ProjectRecord | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    return row ? mapProject(row) : null;
  }

  createWork(
    projectId: string,
    title: string,
    options?: {
      taskType?: string;
      taskInput?: Record<string, unknown>;
      maxRepairs?: number;
    },
  ): WorkRecord {
    const project = this.getProject(projectId);
    if (!project) {
      throw new ControlError("NOT_FOUND", `Unknown project: ${projectId}`);
    }
    const ts = nowIso(this.clock);
    const maxRepairs = options?.maxRepairs ?? 1;
    if (maxRepairs < 0) {
      throw new ControlError("INVALID", "maxRepairs must be >= 0");
    }
    const work: WorkRecord = {
      work_id: newId("wrk"),
      project_id: projectId,
      title,
      state: "QUEUED",
      attempt: 0,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      task_type: options?.taskType ?? null,
      task_input: options?.taskInput ?? null,
      repair_count: 0,
      max_repairs: maxRepairs,
      failure_reason: null,
      created_at: ts,
      updated_at: ts,
    };

    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_items (
             work_id, project_id, title, state, attempt,
             lease_owner, lease_token, lease_expires_at,
             task_type, task_input, repair_count, max_repairs, failure_reason,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          work.work_id,
          work.project_id,
          work.title,
          work.state,
          work.attempt,
          null,
          null,
          null,
          work.task_type,
          work.task_input == null ? null : JSON.stringify(work.task_input),
          work.repair_count,
          work.max_repairs,
          null,
          work.created_at,
          work.updated_at,
        );
      this.insertEvent("work.created", {
        project_id: work.project_id,
        work_id: work.work_id,
        payload: {
          title: work.title,
          state: work.state,
          task_type: work.task_type,
        },
        ts,
      });
    });
    this.flushEventJsonl();
    return work;
  }

  getWork(workId: string): WorkRecord | null {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE work_id = ?")
      .get(workId) as Record<string, unknown> | undefined;
    return row ? mapWork(row) : null;
  }

  /**
   * Atomically claim the oldest QUEUED work item.
   * Returns null when none available.
   */
  claimNextWork(
    workerId: string,
    leaseDurationMs: number,
    now: Date = this.clock(),
  ): WorkRecord | null {
    if (!workerId) {
      throw new ControlError("INVALID", "workerId is required");
    }
    if (!(leaseDurationMs > 0)) {
      throw new ControlError("INVALID", "leaseDurationMs must be positive");
    }

    const claimed = this.withTransaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM work_items
           WHERE state = 'QUEUED'
           ORDER BY created_at ASC, work_id ASC
           LIMIT 1`,
        )
        .get() as Record<string, unknown> | undefined;
      if (!row) {
        return null;
      }

      const workId = String(row.work_id);
      const ts = now.toISOString();
      const expires = new Date(now.getTime() + leaseDurationMs).toISOString();
      const token = newId("lease");
      const nextAttempt = Number(row.attempt) + 1;

      const result = this.db
        .prepare(
          `UPDATE work_items
           SET state = 'RUNNING',
               attempt = ?,
               lease_owner = ?,
               lease_token = ?,
               lease_expires_at = ?,
               updated_at = ?
           WHERE work_id = ? AND state = 'QUEUED'`,
        )
        .run(nextAttempt, workerId, token, expires, ts, workId);

      if (result.changes !== 1) {
        return null;
      }

      this.insertEvent("work.claimed", {
        project_id: String(row.project_id),
        work_id: workId,
        payload: {
          worker_id: workerId,
          lease_token: token,
          lease_expires_at: expires,
          attempt: nextAttempt,
        },
        ts,
      });

      return this.getWork(workId);
    });
    this.flushEventJsonl();
    return claimed;
  }

  /**
   * Complete work only if the caller holds the current unexpired lease
   * AND the latest finished attempt has execution_ok=true and verification PASS.
   */
  completeWork(
    workId: string,
    leaseToken: string,
    workerId: string,
    now: Date = this.clock(),
  ): WorkRecord {
    const completed = this.withTransaction(() => {
      const work = this.assertActiveLease(workId, leaseToken, workerId, now);
      // Latest attempt overall (finished or not) — older PASS cannot authorize.
      const latest = this.db
        .prepare(
          `SELECT * FROM work_attempts
           WHERE work_id = ?
           ORDER BY attempt_number DESC
           LIMIT 1`,
        )
        .get(workId) as Record<string, unknown> | undefined;
      if (!latest) {
        throw new ControlError(
          "COMPLETION_GATE",
          "No attempt available for completion",
        );
      }
      const attempt = mapAttempt(latest);
      if (attempt.finished_at == null) {
        throw new ControlError(
          "COMPLETION_GATE",
          "Latest attempt is unfinished",
        );
      }
      if (
        attempt.execution_ok !== true ||
        attempt.verification_status !== "PASS" ||
        attempt.attempt_outcome !== "PASS"
      ) {
        throw new ControlError(
          "COMPLETION_GATE",
          "Completion requires latest attempt execution_ok=true, verification PASS, and attempt_outcome PASS",
        );
      }

      const ts = now.toISOString();
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET state = 'COMPLETED',
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               failure_reason = NULL,
               updated_at = ?
           WHERE work_id = ?
             AND state = 'RUNNING'
             AND lease_token = ?
             AND lease_owner = ?`,
        )
        .run(ts, workId, leaseToken, workerId);

      if (result.changes !== 1) {
        throw new ControlError("STALE_LEASE", "Lease lost during completion");
      }

      this.insertEvent("work.completed", {
        project_id: work.project_id,
        work_id: workId,
        payload: {
          worker_id: workerId,
          lease_token: leaseToken,
          attempt_id: attempt.attempt_id,
        },
        ts,
      });
      return this.getWork(workId);
    });
    this.flushEventJsonl();
    if (!completed) {
      throw new ControlError("INTERNAL", "Completion did not return work");
    }
    return completed;
  }

  /**
   * Terminal non-completed decision. Clears lease; not claimable; not requeued.
   */
  failWork(
    workId: string,
    leaseToken: string,
    workerId: string,
    reason: string,
    now: Date = this.clock(),
  ): WorkRecord {
    let failed: WorkRecord | null = null;
    this.withTransaction(() => {
      const work = this.assertActiveLease(workId, leaseToken, workerId, now);
      const ts = now.toISOString();
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET state = 'FAILED',
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               failure_reason = ?,
               updated_at = ?
           WHERE work_id = ?
             AND state = 'RUNNING'
             AND lease_token = ?
             AND lease_owner = ?`,
        )
        .run(reason, ts, workId, leaseToken, workerId);
      if (result.changes !== 1) {
        throw new ControlError("STALE_LEASE", "Lease lost during failWork");
      }
      this.insertEvent("work.failed", {
        project_id: work.project_id,
        work_id: workId,
        payload: { worker_id: workerId, reason },
        ts,
      });
      failed = this.getWork(workId);
    });
    this.flushEventJsonl();
    if (!failed) {
      throw new ControlError("INTERNAL", "failWork did not return work");
    }
    return failed;
  }

  /**
   * Requeue RUNNING work whose lease has expired.
   * Unfinished attempts are classified ABANDONED (unknown crash outcome).
   * FAILED work is never requeued.
   */
  recoverExpiredLeases(now: Date = this.clock()): WorkRecord[] {
    const recovered = this.withTransaction(() => {
      const out: WorkRecord[] = [];
      const ts = now.toISOString();
      const rows = this.db
        .prepare(
          `SELECT * FROM work_items
           WHERE state = 'RUNNING'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?
           ORDER BY lease_expires_at ASC, work_id ASC`,
        )
        .all(ts) as Record<string, unknown>[];

      for (const row of rows) {
        const work = mapWork(row);

        const unfinished = this.db
          .prepare(
            `SELECT * FROM work_attempts
             WHERE work_id = ? AND finished_at IS NULL`,
          )
          .all(work.work_id) as Record<string, unknown>[];
        for (const att of unfinished) {
          this.db
            .prepare(
              `UPDATE work_attempts
               SET finished_at = ?,
                   attempt_outcome = 'ABANDONED',
                   verification_detail = COALESCE(verification_detail, ?)
               WHERE attempt_id = ? AND finished_at IS NULL`,
            )
            .run(
              ts,
              "abandoned: lease expired before attempt finalization",
              String(att.attempt_id),
            );
          this.insertEvent("work.attempt_abandoned", {
            project_id: work.project_id,
            work_id: work.work_id,
            payload: {
              attempt_id: String(att.attempt_id),
              previous_owner: work.lease_owner,
              reason: "lease_expired",
            },
            ts,
          });
        }

        const result = this.db
          .prepare(
            `UPDATE work_items
             SET state = 'QUEUED',
                 lease_owner = NULL,
                 lease_token = NULL,
                 lease_expires_at = NULL,
                 updated_at = ?
             WHERE work_id = ?
               AND state = 'RUNNING'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?`,
          )
          .run(ts, work.work_id, ts);

        if (result.changes !== 1) {
          continue;
        }

        this.insertEvent("work.lease_expired", {
          project_id: work.project_id,
          work_id: work.work_id,
          payload: {
            previous_owner: work.lease_owner,
            previous_token: work.lease_token,
            expired_at: work.lease_expires_at,
            attempt: work.attempt,
            abandoned_attempts: unfinished.length,
          },
          ts,
        });
        const after = this.getWork(work.work_id);
        if (after) out.push(after);
      }
      return out;
    });
    this.flushEventJsonl();
    return recovered;
  }

  listEvents(): EventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY ts ASC, event_id ASC")
      .all() as Record<string, unknown>[];
    return rows.map(mapEvent);
  }

  listAttempts(workId: string): AttemptRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_attempts
         WHERE work_id = ?
         ORDER BY attempt_number ASC`,
      )
      .all(workId) as Record<string, unknown>[];
    return rows.map(mapAttempt);
  }

  assertActiveLease(
    workId: string,
    leaseToken: string,
    workerId: string,
    now: Date = this.clock(),
  ): WorkRecord {
    const work = this.getWork(workId);
    if (!work) {
      throw new ControlError("NOT_FOUND", `Unknown work: ${workId}`);
    }
    if (work.state !== "RUNNING") {
      throw new ControlError(
        "ILLEGAL_TRANSITION",
        `Work is not RUNNING (${work.state})`,
      );
    }
    if (
      work.lease_token !== leaseToken ||
      work.lease_owner !== workerId ||
      !work.lease_expires_at
    ) {
      throw new ControlError("STALE_LEASE", "Lease token/owner mismatch");
    }
    if (Date.parse(work.lease_expires_at) <= now.getTime()) {
      throw new ControlError("STALE_LEASE", "Lease has expired");
    }
    return work;
  }

  beginExecutionAttempt(
    workId: string,
    leaseToken: string,
    workerId: string,
    now: Date = this.clock(),
  ): AttemptRecord {
    let attempt: AttemptRecord | null = null;
    this.withTransaction(() => {
      const work = this.assertActiveLease(workId, leaseToken, workerId, now);
      const row = this.db
        .prepare(
          `SELECT COALESCE(MAX(attempt_number), 0) AS max_n
           FROM work_attempts WHERE work_id = ?`,
        )
        .get(workId) as { max_n: number };
      const attemptNumber = Number(row.max_n) + 1;
      const ts = now.toISOString();
      const attemptId = newId("att");
      this.db
        .prepare(
          `INSERT INTO work_attempts (
             attempt_id, work_id, attempt_number, worker_id,
             started_at, finished_at, execution_ok, result_json,
             verification_status, verification_detail, attempt_outcome,
             repair_applied, repair_note, created_at
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?)`,
        )
        .run(attemptId, workId, attemptNumber, workerId, ts, ts);
      this.insertEvent("work.attempt_started", {
        project_id: work.project_id,
        work_id: workId,
        payload: {
          attempt_id: attemptId,
          attempt_number: attemptNumber,
          worker_id: workerId,
        },
        ts,
      });
      attempt = mapAttempt(
        this.db
          .prepare("SELECT * FROM work_attempts WHERE attempt_id = ?")
          .get(attemptId) as Record<string, unknown>,
      );
    });
    this.flushEventJsonl();
    if (!attempt) {
      throw new ControlError("INTERNAL", "Failed to begin attempt");
    }
    return attempt;
  }

  /**
   * Record that handler.execute() is about to run for an open attempt.
   * Distinct from attempt lifecycle — SETUP_ERROR paths never call this.
   */
  recordExecutionStarted(
    workId: string,
    leaseToken: string,
    workerId: string,
    attemptId: string,
    now: Date = this.clock(),
  ): void {
    this.withTransaction(() => {
      const work = this.assertActiveLease(workId, leaseToken, workerId, now);
      const existing = this.db
        .prepare("SELECT * FROM work_attempts WHERE attempt_id = ?")
        .get(attemptId) as Record<string, unknown> | undefined;
      if (!existing || String(existing.work_id) !== workId) {
        throw new ControlError("NOT_FOUND", "Unknown attempt");
      }
      if (existing.finished_at != null) {
        throw new ControlError("INVALID", "Attempt already finished");
      }
      const ts = now.toISOString();
      this.insertEvent("work.execution_started", {
        project_id: work.project_id,
        work_id: workId,
        payload: {
          attempt_id: attemptId,
          worker_id: workerId,
        },
        ts,
      });
    });
    this.flushEventJsonl();
  }

  finishExecutionAttempt(
    args: {
      workId: string;
      leaseToken: string;
      workerId: string;
      attemptId: string;
      executionOk: boolean;
      result: Record<string, unknown>;
      verificationStatus: VerificationStatus;
      verificationDetail: string;
    },
    now: Date = this.clock(),
  ): AttemptRecord {
    let finished: AttemptRecord | null = null;
    this.withTransaction(() => {
      const work = this.assertActiveLease(
        args.workId,
        args.leaseToken,
        args.workerId,
        now,
      );
      const existing = this.db
        .prepare("SELECT * FROM work_attempts WHERE attempt_id = ?")
        .get(args.attemptId) as Record<string, unknown> | undefined;
      if (!existing || String(existing.work_id) !== args.workId) {
        throw new ControlError("NOT_FOUND", "Unknown attempt");
      }
      if (existing.finished_at != null) {
        throw new ControlError("INVALID", "Attempt already finished");
      }
      // Combined gate: PASS only when execution succeeded AND verifier passed.
      const outcome: AttemptOutcome =
        args.executionOk === true && args.verificationStatus === "PASS"
          ? "PASS"
          : "FAIL";
      const ts = now.toISOString();
      this.db
        .prepare(
          `UPDATE work_attempts
           SET finished_at = ?,
               execution_ok = ?,
               result_json = ?,
               verification_status = ?,
               verification_detail = ?,
               attempt_outcome = ?
           WHERE attempt_id = ?`,
        )
        .run(
          ts,
          args.executionOk ? 1 : 0,
          JSON.stringify(args.result),
          args.verificationStatus,
          args.verificationDetail,
          outcome,
          args.attemptId,
        );

      this.insertEvent("work.execution_finished", {
        project_id: work.project_id,
        work_id: args.workId,
        payload: {
          attempt_id: args.attemptId,
          execution_ok: args.executionOk,
          result: args.result,
          attempt_outcome: outcome,
        },
        ts,
      });

      this.insertEvent("work.attempt_finished", {
        project_id: work.project_id,
        work_id: args.workId,
        payload: {
          attempt_id: args.attemptId,
          attempt_outcome: outcome,
          execution_ok: args.executionOk,
          verification_status: args.verificationStatus,
        },
        ts,
      });

      if (args.verificationStatus === "PASS") {
        this.insertEvent("work.verification_passed", {
          project_id: work.project_id,
          work_id: args.workId,
          payload: {
            attempt_id: args.attemptId,
            detail: args.verificationDetail,
            execution_ok: args.executionOk,
          },
          ts,
        });
      } else {
        this.insertEvent("work.verification_failed", {
          project_id: work.project_id,
          work_id: args.workId,
          payload: {
            attempt_id: args.attemptId,
            detail: args.verificationDetail,
            execution_ok: args.executionOk,
          },
          ts,
        });
      }

      finished = mapAttempt(
        this.db
          .prepare("SELECT * FROM work_attempts WHERE attempt_id = ?")
          .get(args.attemptId) as Record<string, unknown>,
      );
    });
    this.flushEventJsonl();
    if (!finished) {
      throw new ControlError("INTERNAL", "Failed to finish attempt");
    }
    return finished;
  }

  /**
   * Finalize an attempt that failed during setup, execute(), or verify().
   * Preserves any known execution result; never claims crash certainty beyond ERROR.
   */
  finalizeAttemptError(
    args: {
      workId: string;
      leaseToken: string;
      workerId: string;
      attemptId: string;
      outcome: "SETUP_ERROR" | "EXEC_ERROR" | "VERIFY_ERROR";
      executionOk: boolean | null;
      result: Record<string, unknown> | null;
      detail: string;
    },
    now: Date = this.clock(),
  ): AttemptRecord {
    let finished: AttemptRecord | null = null;
    this.withTransaction(() => {
      const work = this.assertActiveLease(
        args.workId,
        args.leaseToken,
        args.workerId,
        now,
      );
      const existing = this.db
        .prepare("SELECT * FROM work_attempts WHERE attempt_id = ?")
        .get(args.attemptId) as Record<string, unknown> | undefined;
      if (!existing || String(existing.work_id) !== args.workId) {
        throw new ControlError("NOT_FOUND", "Unknown attempt");
      }
      if (existing.finished_at != null) {
        throw new ControlError("INVALID", "Attempt already finished");
      }
      const ts = now.toISOString();
      this.db
        .prepare(
          `UPDATE work_attempts
           SET finished_at = ?,
               execution_ok = ?,
               result_json = ?,
               verification_status = NULL,
               verification_detail = ?,
               attempt_outcome = ?
           WHERE attempt_id = ? AND finished_at IS NULL`,
        )
        .run(
          ts,
          args.executionOk == null ? null : args.executionOk ? 1 : 0,
          args.result == null ? null : JSON.stringify(args.result),
          args.detail.slice(0, 500),
          args.outcome,
          args.attemptId,
        );

      // SETUP_ERROR never claims execution started/finished.
      // EXEC_ERROR / VERIFY_ERROR: execution was invoked — record finish evidence.
      if (args.outcome === "EXEC_ERROR" || args.outcome === "VERIFY_ERROR") {
        this.insertEvent("work.execution_finished", {
          project_id: work.project_id,
          work_id: args.workId,
          payload: {
            attempt_id: args.attemptId,
            attempt_outcome: args.outcome,
            execution_ok: args.executionOk,
            result: args.result,
            detail: args.detail.slice(0, 500),
          },
          ts,
        });
      }

      this.insertEvent("work.attempt_finished", {
        project_id: work.project_id,
        work_id: args.workId,
        payload: {
          attempt_id: args.attemptId,
          attempt_outcome: args.outcome,
          execution_ok: args.executionOk,
          result: args.result,
          detail: args.detail.slice(0, 500),
        },
        ts,
      });
      finished = mapAttempt(
        this.db
          .prepare("SELECT * FROM work_attempts WHERE attempt_id = ?")
          .get(args.attemptId) as Record<string, unknown>,
      );
    });
    this.flushEventJsonl();
    if (!finished) {
      throw new ControlError("INTERNAL", "Failed to finalize attempt error");
    }
    return finished;
  }

  applyRepair(
    args: {
      workId: string;
      leaseToken: string;
      workerId: string;
      attemptId: string;
      nextInput: Record<string, unknown>;
      note: string;
    },
    now: Date = this.clock(),
  ): WorkRecord {
    let updated: WorkRecord | null = null;
    this.withTransaction(() => {
      const work = this.assertActiveLease(
        args.workId,
        args.leaseToken,
        args.workerId,
        now,
      );
      if (work.repair_count >= work.max_repairs) {
        throw new ControlError("REPAIR_BUDGET", "Repair budget exhausted");
      }
      const attRow = this.db
        .prepare("SELECT * FROM work_attempts WHERE attempt_id = ?")
        .get(args.attemptId) as Record<string, unknown> | undefined;
      if (!attRow || String(attRow.work_id) !== args.workId) {
        throw new ControlError("REPAIR_GATE", "Attempt not found for work");
      }
      const attempt = mapAttempt(attRow);
      if (!attempt.finished_at) {
        throw new ControlError("REPAIR_GATE", "Attempt is not finished");
      }
      if (
        attempt.verification_status !== "FAIL" ||
        attempt.attempt_outcome !== "FAIL"
      ) {
        throw new ControlError(
          "REPAIR_GATE",
          "Repair requires a finished verification FAIL attempt",
        );
      }
      if (attempt.repair_applied) {
        throw new ControlError(
          "REPAIR_GATE",
          "Repair already applied to this attempt",
        );
      }

      const ts = now.toISOString();
      const nextCount = work.repair_count + 1;
      this.db
        .prepare(
          `UPDATE work_items
           SET task_input = ?,
               repair_count = ?,
               updated_at = ?
           WHERE work_id = ?`,
        )
        .run(JSON.stringify(args.nextInput), nextCount, ts, args.workId);
      this.db
        .prepare(
          `UPDATE work_attempts
           SET repair_applied = 1,
               repair_note = ?
           WHERE attempt_id = ?`,
        )
        .run(args.note, args.attemptId);

      this.insertEvent("work.repair_applied", {
        project_id: work.project_id,
        work_id: args.workId,
        payload: {
          attempt_id: args.attemptId,
          repair_count: nextCount,
          max_repairs: work.max_repairs,
          note: args.note,
          task_input: args.nextInput,
        },
        ts,
      });
      updated = this.getWork(args.workId);
    });
    this.flushEventJsonl();
    if (!updated) {
      throw new ControlError("INTERNAL", "Repair did not update work");
    }
    return updated;
  }

  readJsonlEvents(): Array<Record<string, unknown>> {
    const path = eventsJsonlPath(this.stateDir);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return [];
    return text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /**
   * Project unflushed SQLite events to append-only JSONL without duplication.
   * The full read→append→mark sequence runs under BEGIN IMMEDIATE so concurrent
   * processes cannot both append the same event_id. SQLite remains authoritative;
   * if append succeeds and the process dies before COMMIT, restart sees the JSONL
   * line, skips re-append, and converges the flushed marker.
   */
  flushEventJsonl(): number {
    return this.withTransaction(() => {
      const path = eventsJsonlPath(this.stateDir);
      if (!existsSync(path)) {
        writeFileSync(path, "", "utf8");
      }

      const existingIds = new Set(
        this.readJsonlEvents()
          .map((e) => e.event_id)
          .filter((id): id is string => typeof id === "string"),
      );

      const pending = this.db
        .prepare(
          `SELECT * FROM events
           WHERE jsonl_flushed = 0
           ORDER BY ts ASC, event_id ASC`,
        )
        .all() as Record<string, unknown>[];

      let flushed = 0;
      for (const row of pending) {
        const event = mapEvent(row);
        if (!existingIds.has(event.event_id)) {
          const line = JSON.stringify({
            event_id: event.event_id,
            ts: event.ts,
            event_type: event.event_type,
            project_id: event.project_id,
            work_id: event.work_id,
            payload: event.payload,
          });
          appendFileSync(path, `${line}\n`, "utf8");
          existingIds.add(event.event_id);
        }
        this.db
          .prepare("UPDATE events SET jsonl_flushed = 1 WHERE event_id = ?")
          .run(event.event_id);
        flushed += 1;
      }
      return flushed;
    });
  }

  private insertEvent(
    eventType: EventType,
    args: {
      project_id: string | null;
      work_id: string | null;
      payload: Record<string, unknown>;
      ts: string;
    },
  ): void {
    const eventId = newId("evt");
    this.db
      .prepare(
        `INSERT INTO events (
           event_id, ts, event_type, project_id, work_id, payload, jsonl_flushed
         ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        eventId,
        args.ts,
        eventType,
        args.project_id,
        args.work_id,
        JSON.stringify(args.payload),
      );
  }
}
