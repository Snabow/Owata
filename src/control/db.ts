import { DatabaseSync } from "node:sqlite";
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

export function openDatabase(stateDir: string): DatabaseSync {
  const db = new DatabaseSync(dbPath(stateDir));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 30000;");
  migrate(db);
  return db;
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

function migrate(db: DatabaseSync): void {
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
    db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, ?)").run(SCHEMA_VERSION);
  } else if (existing.version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version ${existing.version}; expected ${SCHEMA_VERSION}`,
    );
  }
}
