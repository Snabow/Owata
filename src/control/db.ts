import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "./types.js";

export const DB_FILENAME = "control.sqlite";
export const EVENTS_JSONL_FILENAME = "events.jsonl";

export function dbPath(stateDir: string): string {
  return join(stateDir, DB_FILENAME);
}

export function eventsJsonlPath(stateDir: string): string {
  return join(stateDir, EVENTS_JSONL_FILENAME);
}

export function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const errcode = (err as { errcode?: number }).errcode;
  return code === "ERR_SQLITE_ERROR" && (errcode === 5 || errcode === 6);
}

export function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

export function openDatabase(stateDir: string): DatabaseSync {
  const path = dbPath(stateDir);
  const deadline = Date.now() + 30_000;
  for (;;) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout = 30000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      migrate(db, stateDir);
      return db;
    } catch (err) {
      try {
        db?.close();
      } catch {
        // ignore close errors after a failed open
      }
      if (!isSqliteBusy(err) || Date.now() >= deadline) {
        throw err;
      }
      sleepMs(20);
    }
  }
}

export function verifyWalMode(db: DatabaseSync): boolean {
  const row = db.prepare("PRAGMA journal_mode;").get() as
    | { journal_mode: string }
    | undefined;
  return (row?.journal_mode ?? "").toLowerCase() === "wal";
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    throw new Error("schema_meta missing");
  }
  return row.version;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = tableColumns(db, table);
  if (!cols.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function migrate(db: DatabaseSync, stateDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_items (
      work_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project_id TEXT,
      work_id TEXT,
      payload TEXT NOT NULL,
      jsonl_flushed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_work_queued
      ON work_items(state, created_at);

    CREATE INDEX IF NOT EXISTS idx_work_running_lease
      ON work_items(state, lease_expires_at);

    CREATE INDEX IF NOT EXISTS idx_events_unflushed
      ON events(jsonl_flushed, ts, event_id);
  `);

  const existing = db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as
    | { version: number }
    | undefined;
  if (!existing) {
    // Fresh database starts as exact schema v1, then migrates through the chain.
    db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 1)").run();
  }

  let version = getSchemaVersion(db);

  // Exact migration chain only — never treat unknown versions as v1.
  if (version === 1) {
    migrateToV2(db);
    version = getSchemaVersion(db);
  }
  if (version === 2) {
    migrateToV3(db);
    version = getSchemaVersion(db);
  }
  if (version === 3) {
    migrateToV4(db, stateDir);
    version = getSchemaVersion(db);
  }
  if (version === 4) {
    migrateToV5(db);
    version = getSchemaVersion(db);
  }

  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version ${version}; expected ${SCHEMA_VERSION}`,
    );
  }

  // Idempotent additive columns for already-migrated v5 databases.
  if (version === SCHEMA_VERSION) {
    addColumnIfMissing(db, "cycles", "policy_authorized_by_decision_id", "TEXT");
    addColumnIfMissing(db, "cycles", "recovery_target_request_id", "TEXT");
  }

  // Crash recovery / prior incomplete projection rebuild: converge from SQLite.
  reconcileEventProjection(db, stateDir);
}

function migrateToV2(db: DatabaseSync): void {
  addColumnIfMissing(db, "work_items", "task_type", "TEXT");
  addColumnIfMissing(db, "work_items", "task_input", "TEXT");
  addColumnIfMissing(
    db,
    "work_items",
    "repair_count",
    "INTEGER NOT NULL DEFAULT 0",
  );
  addColumnIfMissing(
    db,
    "work_items",
    "max_repairs",
    "INTEGER NOT NULL DEFAULT 1",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_attempts (
      attempt_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES work_items(work_id),
      attempt_number INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      execution_ok INTEGER,
      result_json TEXT,
      verification_status TEXT,
      verification_detail TEXT,
      repair_applied INTEGER NOT NULL DEFAULT 0,
      repair_note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (work_id, attempt_number)
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_work
      ON work_attempts(work_id, attempt_number);
  `);

  db.prepare("UPDATE schema_meta SET version = 2 WHERE id = 1").run();
}

function migrateToV3(db: DatabaseSync): void {
  addColumnIfMissing(db, "work_items", "failure_reason", "TEXT");
  addColumnIfMissing(db, "work_attempts", "attempt_outcome", "TEXT");
  db.prepare("UPDATE schema_meta SET version = 3 WHERE id = 1").run();
}

/**
 * Schema v4: durable monotonic event_seq + one-time JSONL projection rebuild.
 * Ordinary runtime JSONL remains append-only; only migration/reconcile rebuilds.
 */
function migrateToV4(db: DatabaseSync, stateDir: string): void {
  addColumnIfMissing(db, "events", "event_seq", "INTEGER");

  const missing = db
    .prepare(
      `SELECT event_id, ts FROM events
       WHERE event_seq IS NULL
       ORDER BY ts ASC, event_id ASC`,
    )
    .all() as Array<{ event_id: string; ts: string }>;
  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(event_seq), 0) AS m FROM events`)
    .get() as { m: number };
  let next = Number(maxRow.m) + 1;
  const upd = db.prepare(`UPDATE events SET event_seq = ? WHERE event_id = ?`);
  for (const row of missing) {
    upd.run(next, row.event_id);
    next += 1;
  }

  const nulls = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE event_seq IS NULL`)
    .get() as { c: number };
  if (Number(nulls.c) !== 0) {
    throw new Error("Failed to backfill event_seq for all events");
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_seq ON events(event_seq);
    CREATE INDEX IF NOT EXISTS idx_events_unflushed_seq
      ON events(jsonl_flushed, event_seq);
  `);

  // Rebuild projection before bumping schema version so crash remigrates safely.
  rebuildJsonlProjectionFromSqlite(db, stateDir);
  db.prepare("UPDATE schema_meta SET version = 4 WHERE id = 1").run();
}

/**
 * Schema v5: durable multi-role cycle / envelope / dispatch ownership.
 * Does not change event_seq or JSONL projection contract.
 */
function migrateToV5(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cycles (
      cycle_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      work_package_ref TEXT NOT NULL,
      base_sha TEXT,
      latest_candidate_sha TEXT,
      accepted_candidate_sha TEXT,
      state TEXT NOT NULL,
      current_request_id TEXT,
      policy_json TEXT NOT NULL,
      policy_authorized_by_decision_id TEXT,
      recovery_target_request_id TEXT,
      max_dispatch_retries INTEGER NOT NULL DEFAULT 3,
      recovery_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS envelopes (
      envelope_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),
      kind TEXT NOT NULL,
      request_id TEXT,
      from_role TEXT NOT NULL,
      to_role TEXT,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_envelopes_cycle
      ON envelopes(cycle_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_envelopes_request
      ON envelopes(request_id);

    CREATE TABLE IF NOT EXISTS dispatches (
      dispatch_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),
      request_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      fence_token TEXT NOT NULL,
      owner TEXT NOT NULL,
      target_role TEXT NOT NULL,
      state TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      result_envelope_id TEXT,
      failure_class TEXT,
      failure_detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (cycle_id, request_id, attempt_number)
    );

    CREATE INDEX IF NOT EXISTS idx_dispatches_request
      ON dispatches(cycle_id, request_id, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_dispatches_lease
      ON dispatches(state, lease_expires_at);

    CREATE TABLE IF NOT EXISTS human_gates (
      gate_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),
      decision_envelope_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      allowed_choices_json TEXT NOT NULL,
      state TEXT NOT NULL,
      selected_choice TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(db, "cycles", "policy_authorized_by_decision_id", "TEXT");
  addColumnIfMissing(db, "cycles", "recovery_target_request_id", "TEXT");
  db.prepare("UPDATE schema_meta SET version = 5 WHERE id = 1").run();
}

/**
 * Read JSONL projection lines.
 * Unreadable / syntactically invalid projection is treated as non-canonical
 * (returns null), not as an authoritative-state failure.
 */
function tryReadJsonlLines(
  stateDir: string,
): Array<Record<string, unknown>> | null {
  const path = eventsJsonlPath(stateDir);
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return [];
    return text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function projectionMatchesSqlite(db: DatabaseSync, stateDir: string): boolean {
  const lines = tryReadJsonlLines(stateDir);
  // Malformed / unreadable destination JSONL → rebuild from SQLite.
  if (lines == null) return false;
  // Legacy pre-v4 lines lack event_seq → rebuild.
  if (lines.some((line) => line.event_seq == null)) return false;

  // JSONL must be in ascending event_seq order.
  for (let i = 1; i < lines.length; i += 1) {
    if (Number(lines[i - 1].event_seq) > Number(lines[i].event_seq)) {
      return false;
    }
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    const id = String(line.event_id);
    if (byId.has(id)) return false; // duplicate identity in projection
    byId.set(id, line);
  }

  // Every JSONL line must match its authoritative SQLite row.
  const lookup = db.prepare(`SELECT * FROM events WHERE event_id = ?`);
  for (const line of lines) {
    const row = lookup.get(String(line.event_id)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false; // extra projection event
    if (Number(line.event_seq) !== Number(row.event_seq)) return false;
    if (String(line.ts) !== String(row.ts)) return false;
    if (String(line.event_type) !== String(row.event_type)) return false;
    const lineProject =
      line.project_id == null ? null : String(line.project_id);
    const rowProject =
      row.project_id == null ? null : String(row.project_id);
    if (lineProject !== rowProject) return false;
    const lineWork = line.work_id == null ? null : String(line.work_id);
    const rowWork = row.work_id == null ? null : String(row.work_id);
    if (lineWork !== rowWork) return false;
    const rowPayload = JSON.parse(String(row.payload));
    if (JSON.stringify(line.payload) !== JSON.stringify(rowPayload)) {
      return false;
    }
  }

  // Every committed flushed SQLite event must appear in JSONL.
  // Unflushed rows may be absent (ordinary append-only pending projection).
  // JSONL may temporarily include lines for rows whose flushed bit is not yet
  // visible to other processes; that is not a rebuild trigger.
  const flushed = db
    .prepare(
      `SELECT event_id FROM events
       WHERE jsonl_flushed = 1
       ORDER BY event_seq ASC`,
    )
    .all() as Array<{ event_id: string }>;
  for (const row of flushed) {
    if (!byId.has(String(row.event_id))) return false;
  }
  return true;
}

/**
 * Crash-safe atomic replace of events.jsonl.
 * Writes temp file then renames into place (Windows-safe aside swap).
 */
function atomicReplaceFile(tmpPath: string, destPath: string): void {
  if (existsSync(destPath)) {
    const aside = `${destPath}.aside`;
    try {
      unlinkSync(aside);
    } catch {
      // ignore
    }
    renameSync(destPath, aside);
    try {
      renameSync(tmpPath, destPath);
      try {
        unlinkSync(aside);
      } catch {
        // best-effort cleanup
      }
    } catch (err) {
      try {
        renameSync(aside, destPath);
      } catch {
        // ignore restore failure; next open will rebuild from SQLite
      }
      throw err;
    }
  } else {
    renameSync(tmpPath, destPath);
  }
}

function rebuildJsonlProjectionFromSqlite(
  db: DatabaseSync,
  stateDir: string,
): void {
  const rows = db
    .prepare(
      `SELECT event_id, event_seq, ts, event_type, project_id, work_id, payload
       FROM events
       ORDER BY event_seq ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  const dest = eventsJsonlPath(stateDir);
  const tmp = `${dest}.tmp`;
  const body =
    rows.length === 0
      ? ""
      : `${rows
          .map((row) =>
            JSON.stringify({
              event_id: String(row.event_id),
              event_seq: Number(row.event_seq),
              ts: String(row.ts),
              event_type: String(row.event_type),
              project_id:
                row.project_id == null ? null : String(row.project_id),
              work_id: row.work_id == null ? null : String(row.work_id),
              payload: JSON.parse(String(row.payload)),
            }),
          )
          .join("\n")}\n`;

  try {
    unlinkSync(tmp);
  } catch {
    // ignore
  }
  writeFileSync(tmp, body, "utf8");
  atomicReplaceFile(tmp, dest);

  db.prepare(`UPDATE events SET jsonl_flushed = 1`).run();
}

/**
 * Ensure JSONL matches authoritative SQLite event_seq order.
 * Used after v4 migration and on every open for crash convergence.
 */
function reconcileEventProjection(db: DatabaseSync, stateDir: string): void {
  if (getSchemaVersion(db) !== SCHEMA_VERSION) return;
  if (!tableColumns(db, "events").has("event_seq")) return;
  if (projectionMatchesSqlite(db, stateDir)) return;
  rebuildJsonlProjectionFromSqlite(db, stateDir);
}
