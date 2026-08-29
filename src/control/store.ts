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
  openDatabase,
  verifyWalMode,
} from "./db.js";
import { newId, nowIso } from "./ids.js";
import {
  ControlError,
  type EventRecord,
  type EventType,
  type ProjectRecord,
  type ProjectState,
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
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
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
    this.db.exec("BEGIN IMMEDIATE");
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

  createWork(projectId: string, title: string): WorkRecord {
    const project = this.getProject(projectId);
    if (!project) {
      throw new ControlError("NOT_FOUND", `Unknown project: ${projectId}`);
    }
    const ts = nowIso(this.clock);
    const work: WorkRecord = {
      work_id: newId("wrk"),
      project_id: projectId,
      title,
      state: "QUEUED",
      attempt: 0,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      created_at: ts,
      updated_at: ts,
    };

    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_items (
             work_id, project_id, title, state, attempt,
             lease_owner, lease_token, lease_expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          work.created_at,
          work.updated_at,
        );
      this.insertEvent("work.created", {
        project_id: work.project_id,
        work_id: work.work_id,
        payload: { title: work.title, state: work.state },
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
   * Complete work only if the caller holds the current unexpired lease.
   */
  completeWork(
    workId: string,
    leaseToken: string,
    workerId: string,
    now: Date = this.clock(),
  ): WorkRecord {
    const completed = this.withTransaction(() => {
      const row = this.db
        .prepare("SELECT * FROM work_items WHERE work_id = ?")
        .get(workId) as Record<string, unknown> | undefined;
      if (!row) {
        throw new ControlError("NOT_FOUND", `Unknown work: ${workId}`);
      }
      const work = mapWork(row);
      if (work.state !== "RUNNING") {
        throw new ControlError(
          "ILLEGAL_TRANSITION",
          `Cannot complete work in state ${work.state}`,
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

      const ts = now.toISOString();
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET state = 'COMPLETED',
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
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
        payload: { worker_id: workerId, lease_token: leaseToken },
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
   * Requeue RUNNING work whose lease has expired.
   * Preserves work_id and attempt history; clears stale lease fields.
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
   * SQLite remains authoritative; restart safely completes a crashed flush.
   */
  flushEventJsonl(): number {
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
