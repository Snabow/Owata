import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ControlError,
  ControlStore,
  dbPath,
  eventsJsonlPath,
  SCHEMA_VERSION,
} from "../control/index.js";
import {
  registerTaskHandler,
  runOnce,
  runOwnedWork,
  sumTwoHandler,
  unregisterTaskHandler,
  type TaskHandler,
} from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runOnceJs = join(root, "dist", "worker", "fixtures", "run-once.js");

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-wp002-r1-"));
}

function cleanup(dir: string): void {
  // Windows may briefly retain SQLite WAL handles after close.
  for (let i = 0; i < 12; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: temp dirs are cleaned by OS; do not fail assertions.
  }
}

function seedSumTwo(
  store: ControlStore,
  input: Record<string, unknown>,
  maxRepairs = 1,
) {
  const project = store.createProject("wp002");
  return store.createWork(project.project_id, "sum-two-demo", {
    taskType: "sum_two",
    taskInput: input,
    maxRepairs,
  });
}

/** Build an exact schema-v1 database (WP-001 shape) without going through current migrate. */
function createExactV1Database(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(dbPath(stateDir));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_items (
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
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project_id TEXT,
      work_id TEXT,
      payload TEXT NOT NULL,
      jsonl_flushed INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 1)").run();
  db.prepare(
    `INSERT INTO projects VALUES ('prj_v1','legacy','ACTIVE','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO work_items VALUES (
      'wrk_v1','prj_v1','legacy-work','QUEUED',0,NULL,NULL,NULL,
      '2026-01-01T00:00:01.000Z','2026-01-01T00:00:01.000Z'
    )`,
  ).run();
  db.close();
}

/** Exact schema-v3 DB + already-flushed pre-v4 JSONL with intentional order mismatch. */
function createExactV3LegacyWithDivergentJsonl(stateDir: string): {
  eventIdsByBackfillOrder: string[];
  jsonlAppendOrder: string[];
  payloads: Record<string, Record<string, unknown>>;
} {
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(dbPath(stateDir));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_items (
      work_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      task_type TEXT,
      task_input TEXT,
      repair_count INTEGER NOT NULL DEFAULT 0,
      max_repairs INTEGER NOT NULL DEFAULT 1,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_attempts (
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
      attempt_outcome TEXT,
      repair_applied INTEGER NOT NULL DEFAULT 0,
      repair_note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (work_id, attempt_number)
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project_id TEXT,
      work_id TEXT,
      payload TEXT NOT NULL,
      jsonl_flushed INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 3)").run();
  db.prepare(
    `INSERT INTO projects VALUES ('prj_v3','legacy3','ACTIVE','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO work_items (
       work_id, project_id, title, state, attempt,
       lease_owner, lease_token, lease_expires_at,
       task_type, task_input, repair_count, max_repairs, failure_reason,
       created_at, updated_at
     ) VALUES (
       'wrk_v3','prj_v3','legacy-v3','QUEUED',0,
       NULL,NULL,NULL,
       'sum_two','{"a":1}',0,1,NULL,
       '2026-01-01T00:00:01.000Z','2026-01-01T00:00:01.000Z'
     )`,
  ).run();

  const sameTs = "2026-02-01T00:00:00.000Z";
  // Backfill order is ts ASC, event_id ASC → evt_a then evt_z (same ts).
  const payloads: Record<string, Record<string, unknown>> = {
    evt_a: { mark: "a", n: 1 },
    evt_z: { mark: "z", n: 2 },
    evt_mid: { mark: "mid", n: 3 },
  };
  const eventIdsByBackfillOrder = ["evt_a", "evt_z", "evt_mid"];
  db.prepare(
    `INSERT INTO events (event_id, ts, event_type, project_id, work_id, payload, jsonl_flushed)
     VALUES (?, ?, 'work.created', 'prj_v3', 'wrk_v3', ?, 1)`,
  ).run("evt_z", sameTs, JSON.stringify(payloads.evt_z));
  db.prepare(
    `INSERT INTO events (event_id, ts, event_type, project_id, work_id, payload, jsonl_flushed)
     VALUES (?, ?, 'work.created', 'prj_v3', 'wrk_v3', ?, 1)`,
  ).run("evt_a", sameTs, JSON.stringify(payloads.evt_a));
  db.prepare(
    `INSERT INTO events (event_id, ts, event_type, project_id, work_id, payload, jsonl_flushed)
     VALUES (?, ?, 'work.created', 'prj_v3', 'wrk_v3', ?, 1)`,
  ).run("evt_mid", "2026-02-01T00:00:01.000Z", JSON.stringify(payloads.evt_mid));
  db.close();

  // Pre-v4 JSONL: no event_seq, append order intentionally differs from backfill.
  const jsonlAppendOrder = ["evt_z", "evt_mid", "evt_a"];
  const lines = jsonlAppendOrder.map((id) =>
    JSON.stringify({
      event_id: id,
      ts: id === "evt_mid" ? "2026-02-01T00:00:01.000Z" : sameTs,
      event_type: "work.created",
      project_id: "prj_v3",
      work_id: "wrk_v3",
      payload: payloads[id],
    }),
  );
  writeFileSync(eventsJsonlPath(stateDir), `${lines.join("\n")}\n`, "utf8");
  return { eventIdsByBackfillOrder, jsonlAppendOrder, payloads };
}

test("execution ok + verify PASS → COMPLETED", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.completed, true);
    assert.equal(result.work.state, "COMPLETED");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-001: execution false + verifier PASS cannot complete", () => {
  const dir = tempState();
  const taskType = "false_pass";
  const handler: TaskHandler = {
    taskType,
    execute: () => ({ ok: false, output: { reason: "failed_exec" } }),
    verify: () => ({ status: "PASS", detail: "liar" }),
    repair: () => null,
  };
  registerTaskHandler(handler);
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("gate");
    const work = store.createWork(project.project_id, "bad", {
      taskType,
      taskInput: {},
      maxRepairs: 0,
    });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.completed, false);
    assert.equal(result.failed, true);
    assert.equal(result.work.state, "FAILED");
    const att = store.listAttempts(result.work.work_id)[0];
    assert.equal(att.execution_ok, false);
    assert.equal(att.verification_status, "PASS");
    assert.equal(att.attempt_outcome, "FAIL");

    // Direct completeWork cannot bypass (lease already cleared on FAILED).
    // Reproduce gate on a fresh RUNNING claim with same contradictory finish.
    const project2 = store.createProject("gate2");
    const work2 = store.createWork(project2.project_id, "bad2", {
      taskType,
      taskInput: {},
      maxRepairs: 0,
    });
    const claimed = store.claimNextWork("w2", 5000)!;
    const att2 = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w2",
    );
    store.finishExecutionAttempt({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w2",
      attemptId: att2.attempt_id,
      executionOk: false,
      result: { reason: "failed_exec" },
      verificationStatus: "PASS",
      verificationDetail: "liar",
    });
    assert.throws(
      () =>
        store.completeWork(claimed.work_id, claimed.lease_token!, "w2"),
      (e: unknown) => e instanceof ControlError && e.code === "COMPLETION_GATE",
    );
    assert.equal(store.getWork(claimed.work_id)?.state, "RUNNING");

    store.close();
    const again = ControlStore.open({ stateDir: dir });
    const preserved = again.listAttempts(work.work_id)[0];
    assert.equal(preserved.execution_ok, false);
    assert.equal(preserved.verification_status, "PASS");
    assert.equal(preserved.attempt_outcome, "FAIL");
    assert.equal(again.getWork(work.work_id)?.state, "FAILED");
    void work2;
    again.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-008: older PASS + newer unfinished cannot complete", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const claimed = store.claimNextWork("w1", 5000)!;
    const a1 = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
    );
    store.finishExecutionAttempt({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w1",
      attemptId: a1.attempt_id,
      executionOk: true,
      result: { sum: 5 },
      verificationStatus: "PASS",
      verificationDetail: "ok",
    });
    const a2 = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
    );
    assert.throws(
      () =>
        store.completeWork(claimed.work_id, claimed.lease_token!, "w1"),
      (e: unknown) => e instanceof ControlError && e.code === "COMPLETION_GATE",
    );
    assert.equal(store.getWork(claimed.work_id)?.state, "RUNNING");
    assert.equal(store.listAttempts(claimed.work_id).length, 2);
    assert.equal(
      store.listAttempts(claimed.work_id).find((a) => a.attempt_id === a2.attempt_id)
        ?.finished_at,
      null,
    );
    assert.equal(
      store.listEvents().some((e) => e.event_type === "work.completed"),
      false,
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-008: older PASS + newer FAIL cannot complete", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const claimed = store.claimNextWork("w1", 5000)!;
    const a1 = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
    );
    store.finishExecutionAttempt({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w1",
      attemptId: a1.attempt_id,
      executionOk: true,
      result: { sum: 5 },
      verificationStatus: "PASS",
      verificationDetail: "ok",
    });
    const a2 = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
    );
    store.finishExecutionAttempt({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w1",
      attemptId: a2.attempt_id,
      executionOk: true,
      result: { sum: 0 },
      verificationStatus: "FAIL",
      verificationDetail: "bad",
    });
    assert.throws(
      () =>
        store.completeWork(claimed.work_id, claimed.lease_token!, "w1"),
      (e: unknown) => e instanceof ControlError && e.code === "COMPLETION_GATE",
    );
    assert.equal(store.getWork(claimed.work_id)?.state, "RUNNING");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-006: repair() throws → terminal FAILED; no re-execution", () => {
  const dir = tempState();
  const taskType = "repair_throws";
  registerTaskHandler({
    taskType,
    execute: () => ({ ok: true, output: { v: 1 } }),
    verify: () => ({ status: "FAIL", detail: "need-repair" }),
    repair: () => {
      throw new Error("repair-boom");
    },
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("rerr");
    const work = store.createWork(project.project_id, "t", {
      taskType,
      taskInput: { n: 0 },
      maxRepairs: 2,
    });
    const first = runOnce(store, "w1", 5000);
    assert.ok(first);
    assert.equal(first.failed, true);
    assert.equal(first.work.state, "FAILED");
    assert.match(first.work.failure_reason ?? "", /^repair_error:repair-boom/);
    assert.equal(store.listAttempts(work.work_id).length, 1);
    assert.equal(store.getWork(work.work_id)?.repair_count, 0);
    const failAtt = store.listAttempts(work.work_id)[0];
    assert.equal(failAtt.attempt_outcome, "FAIL");
    assert.equal(failAtt.repair_applied, false);

    for (let i = 0; i < 3; i += 1) {
      assert.equal(runOnce(store, `w${i + 2}`, 5000), null);
    }
    store.close();

    const again = ControlStore.open({ stateDir: dir });
    assert.equal(again.getWork(work.work_id)?.state, "FAILED");
    assert.equal(again.getWork(work.work_id)?.repair_count, 0);
    assert.equal(again.listAttempts(work.work_id).length, 1);
    assert.match(
      again.getWork(work.work_id)?.failure_reason ?? "",
      /^repair_error:repair-boom/,
    );
    assert.equal(runOnce(again, "wx", 5000), null);
    again.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-007: missing execution spec → SETUP_ERROR + FAILED", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("nospec");
    const work = store.createWork(project.project_id, "bare");
    assert.equal(work.task_type, null);
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.failed, true);
    assert.equal(result.work.state, "FAILED");
    assert.match(result.work.failure_reason ?? "", /^setup_error:/);
    const att = store.listAttempts(work.work_id)[0];
    assert.ok(att.finished_at);
    assert.equal(att.attempt_outcome, "SETUP_ERROR");
    assert.equal(att.execution_ok, null);
    assert.ok(att.verification_detail);

    const types = store.listEvents().map((e) => e.event_type);
    assert.ok(types.includes("work.attempt_started"));
    assert.ok(types.includes("work.attempt_finished"));
    assert.equal(types.includes("work.execution_started"), false);
    assert.equal(types.includes("work.execution_finished"), false);

    const jsonl = store.readJsonlEvents().map((e) => e.event_type);
    assert.equal(jsonl.includes("work.execution_started"), false);
    assert.equal(jsonl.includes("work.execution_finished"), false);
    assert.ok(jsonl.includes("work.attempt_started"));
    assert.ok(jsonl.includes("work.attempt_finished"));

    assert.equal(runOnce(store, "w2", 5000), null);
    store.close();

    const again = ControlStore.open({ stateDir: dir });
    assert.equal(again.getWork(work.work_id)?.state, "FAILED");
    assert.equal(again.listAttempts(work.work_id)[0].attempt_outcome, "SETUP_ERROR");
    assert.equal(runOnce(again, "w3", 5000), null);
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-007: unknown task type → SETUP_ERROR + FAILED", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("unk");
    const work = store.createWork(project.project_id, "mystery", {
      taskType: "no_such_handler",
      taskInput: { x: 1 },
      maxRepairs: 0,
    });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.failed, true);
    assert.equal(result.work.state, "FAILED");
    assert.match(result.work.failure_reason ?? "", /^setup_error:/);
    const att = store.listAttempts(work.work_id)[0];
    assert.equal(att.attempt_outcome, "SETUP_ERROR");
    assert.equal(att.execution_ok, null);
    assert.match(att.verification_detail ?? "", /Unknown task_type/);

    const types = store.listEvents().map((e) => e.event_type);
    assert.ok(types.includes("work.attempt_started"));
    assert.ok(types.includes("work.attempt_finished"));
    assert.equal(types.includes("work.execution_started"), false);
    assert.equal(types.includes("work.execution_finished"), false);

    assert.equal(runOnce(store, "w2", 5000), null);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-007: execute path emits truthful execution evidence", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result?.completed);
    const types = store.listEvents().map((e) => e.event_type);
    assert.ok(types.includes("work.attempt_started"));
    assert.ok(types.includes("work.execution_started"));
    assert.ok(types.includes("work.execution_finished"));
    assert.ok(types.includes("work.attempt_finished"));
    assert.ok(types.includes("work.verification_passed"));
    assert.ok(types.includes("work.completed"));
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-007: execute throw records that execution began", () => {
  const dir = tempState();
  const taskType = "exec_throw_events";
  registerTaskHandler({
    taskType,
    execute: () => {
      throw new Error("boom-exec");
    },
    verify: () => ({ status: "PASS", detail: "n/a" }),
    repair: () => null,
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("exev");
    store.createWork(project.project_id, "t", {
      taskType,
      taskInput: {},
      maxRepairs: 0,
    });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result?.failed);
    const types = store.listEvents().map((e) => e.event_type);
    assert.ok(types.includes("work.attempt_started"));
    assert.ok(types.includes("work.execution_started"));
    assert.ok(types.includes("work.execution_finished"));
    assert.ok(types.includes("work.attempt_finished"));
    assert.equal(
      store.listAttempts(result!.work.work_id)[0].attempt_outcome,
      "EXEC_ERROR",
    );
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-009: repair.nextInput getter throws → FAILED", () => {
  const dir = tempState();
  const taskType = "repair_next_throw";
  registerTaskHandler({
    taskType,
    execute: () => ({ ok: true, output: { v: 1 } }),
    verify: () => ({ status: "FAIL", detail: "need-repair" }),
    repair: () =>
      ({
        get nextInput(): Record<string, unknown> {
          throw new Error("nextInput-boom");
        },
        get note(): string {
          return "n";
        },
      }) as ReturnType<TaskHandler["repair"]> & object,
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("rn");
    const work = store.createWork(project.project_id, "t", {
      taskType,
      taskInput: {},
      maxRepairs: 2,
    });
    const first = runOnce(store, "w1", 5000);
    assert.ok(first?.failed);
    assert.equal(first.work.state, "FAILED");
    assert.match(first.work.failure_reason ?? "", /^repair_error:nextInput-boom/);
    assert.equal(store.getWork(work.work_id)?.repair_count, 0);
    assert.equal(
      store.listEvents().some((e) => e.event_type === "work.repair_applied"),
      false,
    );
    assert.equal(store.listAttempts(work.work_id)[0].attempt_outcome, "FAIL");
    assert.equal(runOnce(store, "w2", 5000), null);
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-009: repair.note getter throws → FAILED", () => {
  const dir = tempState();
  const taskType = "repair_note_throw";
  registerTaskHandler({
    taskType,
    execute: () => ({ ok: true, output: { v: 1 } }),
    verify: () => ({ status: "FAIL", detail: "need-repair" }),
    repair: () =>
      ({
        get nextInput(): Record<string, unknown> {
          return { fixed: true };
        },
        get note(): string {
          throw new Error("note-boom");
        },
      }) as ReturnType<TaskHandler["repair"]> & object,
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("rn2");
    const work = store.createWork(project.project_id, "t", {
      taskType,
      taskInput: {},
      maxRepairs: 2,
    });
    const first = runOnce(store, "w1", 5000);
    assert.ok(first?.failed);
    assert.match(first.work.failure_reason ?? "", /^repair_error:note-boom/);
    assert.equal(store.getWork(work.work_id)?.repair_count, 0);
    assert.equal(runOnce(store, "w2", 5000), null);
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-009: invalid repair result shape → FAILED", () => {
  const dir = tempState();
  const taskType = "repair_bad_shape";
  registerTaskHandler({
    taskType,
    execute: () => ({ ok: true, output: { v: 1 } }),
    verify: () => ({ status: "FAIL", detail: "need-repair" }),
    repair: () =>
      ({
        nextInput: null,
        note: "x",
      }) as unknown as NonNullable<ReturnType<TaskHandler["repair"]>>,
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("rs");
    const work = store.createWork(project.project_id, "t", {
      taskType,
      taskInput: {},
      maxRepairs: 2,
    });
    const first = runOnce(store, "w1", 5000);
    assert.ok(first?.failed);
    assert.match(first.work.failure_reason ?? "", /^repair_error:/);
    assert.equal(store.getWork(work.work_id)?.repair_count, 0);
    assert.equal(
      store.listEvents().some((e) => e.event_type === "work.repair_applied"),
      false,
    );
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-009: STALE_LEASE during applyRepair is not swallowed", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: true }, 2);
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const claimed = store.claimNextWork("stale", 1000, t0)!;
    const att = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "stale",
      t0,
    );
    store.finishExecutionAttempt(
      {
        workId: claimed.work_id,
        leaseToken: claimed.lease_token!,
        workerId: "stale",
        attemptId: att.attempt_id,
        executionOk: true,
        result: { sum: 6 },
        verificationStatus: "FAIL",
        verificationDetail: "bug",
      },
      t0,
    );
    // Lease expired but work still RUNNING under old ownership — fencing must reject.
    const afterExpiry = new Date("2026-01-01T00:00:01.000Z");
    assert.throws(
      () =>
        store.applyRepair(
          {
            workId: claimed.work_id,
            leaseToken: claimed.lease_token!,
            workerId: "stale",
            attemptId: att.attempt_id,
            nextInput: { a: 2, b: 3, expected: 5, bug: false },
            note: "late",
          },
          afterExpiry,
        ),
      (e: unknown) => e instanceof ControlError && e.code === "STALE_LEASE",
    );
    assert.equal(store.getWork(claimed.work_id)?.state, "RUNNING");
    assert.equal(store.getWork(claimed.work_id)?.repair_count, 0);
    assert.equal(
      store.listEvents().some((e) => e.event_type === "work.repair_applied"),
      false,
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("fail → repair → pass → COMPLETED with repair linkage", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const work = seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: true }, 1);
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.completed, true);
    assert.equal(result.work.state, "COMPLETED");

    const attempts = store.listAttempts(work.work_id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].verification_status, "FAIL");
    assert.equal(attempts[0].repair_applied, true);
    assert.ok(attempts[0].repair_note);
    assert.equal(attempts[1].verification_status, "PASS");

    const repairEvt = store
      .listEvents()
      .find((e) => e.event_type === "work.repair_applied");
    assert.ok(repairEvt);
    assert.equal(repairEvt.payload.attempt_id, attempts[0].attempt_id);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-003: repair budget exhaustion → FAILED; no re-execution", () => {
  const dir = tempState();
  const taskType = "always_fail";
  registerTaskHandler({
    taskType,
    execute: () => ({ ok: true, output: { v: 1 } }),
    verify: () => ({ status: "FAIL", detail: "always" }),
    repair: (input) => ({ nextInput: { ...input, n: Number(input.n ?? 0) + 1 }, note: "noop" }),
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("exh");
    const work = store.createWork(project.project_id, "perm", {
      taskType,
      taskInput: { n: 0 },
      maxRepairs: 1,
    });
    const first = runOnce(store, "w1", 5000);
    assert.ok(first);
    assert.equal(first.work.state, "FAILED");
    assert.equal(first.reason, "repair_budget_exhausted");
    const attemptsAfterFirst = store.listAttempts(work.work_id).length;

    for (let i = 0; i < 4; i += 1) {
      const again = runOnce(store, `w${i + 2}`, 5000);
      assert.equal(again, null);
    }
    assert.equal(store.getWork(work.work_id)?.state, "FAILED");
    assert.equal(store.listAttempts(work.work_id).length, attemptsAfterFirst);

    // Lease recovery must not resurrect FAILED work.
    store.recoverExpiredLeases(new Date("2099-01-01T00:00:00.000Z"));
    assert.equal(store.getWork(work.work_id)?.state, "FAILED");
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-002: execute throw finalized as EXEC_ERROR then FAILED", () => {
  const dir = tempState();
  const taskType = "exec_throw";
  registerTaskHandler({
    taskType,
    execute: () => {
      throw new Error("boom-exec");
    },
    verify: () => ({ status: "PASS", detail: "n/a" }),
    repair: () => null,
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("ex");
    store.createWork(project.project_id, "t", {
      taskType,
      taskInput: {},
      maxRepairs: 0,
    });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.work.state, "FAILED");
    const att = store.listAttempts(result.work.work_id)[0];
    assert.ok(att.finished_at);
    assert.equal(att.attempt_outcome, "EXEC_ERROR");
    assert.match(att.verification_detail ?? "", /boom-exec/);
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-002: verify throw preserves execution result as VERIFY_ERROR", () => {
  const dir = tempState();
  const taskType = "verify_throw";
  registerTaskHandler({
    taskType,
    execute: () => ({ ok: true, output: { kept: 42 } }),
    verify: () => {
      throw new Error("boom-verify");
    },
    repair: () => null,
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("vx");
    store.createWork(project.project_id, "t", {
      taskType,
      taskInput: {},
      maxRepairs: 0,
    });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.work.state, "FAILED");
    const att = store.listAttempts(result.work.work_id)[0];
    assert.equal(att.attempt_outcome, "VERIFY_ERROR");
    assert.equal(att.execution_ok, true);
    assert.equal(att.result_json?.kept, 42);
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});

test("WP002-IR-004: repair provenance and ordering gates", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 1, b: 1, expected: 2, bug: true }, 2);
    const claimed = store.claimNextWork("w1", 5000)!;

    assert.throws(
      () =>
        store.applyRepair({
          workId: claimed.work_id,
          leaseToken: claimed.lease_token!,
          workerId: "w1",
          attemptId: "missing",
          nextInput: { a: 1, b: 1, expected: 2, bug: false },
          note: "nope",
        }),
      (e: unknown) => e instanceof ControlError && e.code === "REPAIR_GATE",
    );

    const passAtt = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
    );
    store.finishExecutionAttempt({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w1",
      attemptId: passAtt.attempt_id,
      executionOk: true,
      result: { sum: 2 },
      verificationStatus: "PASS",
      verificationDetail: "ok",
    });
    assert.throws(
      () =>
        store.applyRepair({
          workId: claimed.work_id,
          leaseToken: claimed.lease_token!,
          workerId: "w1",
          attemptId: passAtt.attempt_id,
          nextInput: { a: 1, b: 1, expected: 2, bug: false },
          note: "after pass",
        }),
      (e: unknown) => e instanceof ControlError && e.code === "REPAIR_GATE",
    );

    const errAtt = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
    );
    store.finalizeAttemptError({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w1",
      attemptId: errAtt.attempt_id,
      outcome: "EXEC_ERROR",
      executionOk: null,
      result: null,
      detail: "err",
    });
    assert.throws(
      () =>
        store.applyRepair({
          workId: claimed.work_id,
          leaseToken: claimed.lease_token!,
          workerId: "w1",
          attemptId: errAtt.attempt_id,
          nextInput: { a: 1, b: 1, expected: 2, bug: false },
          note: "after error",
        }),
      (e: unknown) => e instanceof ControlError && e.code === "REPAIR_GATE",
    );

    const failAtt = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
    );
    const finished = store.finishExecutionAttempt({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w1",
      attemptId: failAtt.attempt_id,
      executionOk: true,
      result: { sum: 3 },
      verificationStatus: "FAIL",
      verificationDetail: "bad",
    });
    store.applyRepair({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w1",
      attemptId: finished.attempt_id,
      nextInput: { a: 1, b: 1, expected: 2, bug: false },
      note: "linked",
    });
    assert.throws(
      () =>
        store.applyRepair({
          workId: claimed.work_id,
          leaseToken: claimed.lease_token!,
          workerId: "w1",
          attemptId: finished.attempt_id,
          nextInput: { a: 1, b: 1, expected: 2, bug: false },
          note: "again",
        }),
      (e: unknown) => e instanceof ControlError && e.code === "REPAIR_GATE",
    );

    store.close();
    const again = ControlStore.open({ stateDir: dir });
    const linked = again
      .listAttempts(claimed.work_id)
      .find((a) => a.attempt_id === finished.attempt_id)!;
    assert.equal(linked.repair_applied, true);
    assert.equal(linked.repair_note, "linked");
    const evt = again
      .listEvents()
      .find((e) => e.event_type === "work.repair_applied")!;
    assert.equal(evt.payload.attempt_id, finished.attempt_id);
    assert.equal(again.getWork(claimed.work_id)?.repair_count, 1);
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-005 + migration: exact v1→v4 preserves rows; v0/future rejected", () => {
  const v1dir = tempState();
  try {
    createExactV1Database(v1dir);
    const store = ControlStore.open({ stateDir: v1dir });
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    const project = store.getProject("prj_v1");
    const work = store.getWork("wrk_v1");
    assert.ok(project);
    assert.equal(project.created_at, "2026-01-01T00:00:00.000Z");
    assert.ok(work);
    assert.equal(work.title, "legacy-work");
    assert.equal(work.task_type, null);
    assert.equal(work.repair_count, 0);
    assert.equal(work.max_repairs, 1);
    assert.equal(work.failure_reason, null);
    // Migrated events receive unique event_seq.
    const seqs = store.listEvents().map((e) => e.event_seq);
    assert.equal(new Set(seqs).size, seqs.length);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    store.close();

    const reopen = ControlStore.open({ stateDir: v1dir });
    assert.equal(reopen.schemaVersion(), SCHEMA_VERSION);
    reopen.close();
  } finally {
    cleanup(v1dir);
  }

  const v0 = tempState();
  try {
    createExactV1Database(v0);
    const db = new DatabaseSync(dbPath(v0));
    db.prepare("UPDATE schema_meta SET version = 0 WHERE id = 1").run();
    db.close();
    assert.throws(() => ControlStore.open({ stateDir: v0 }), /Unsupported schema version 0/);
  } finally {
    cleanup(v0);
  }

  const future = tempState();
  try {
    const store = ControlStore.open({ stateDir: future });
    store.close();
    const db = new DatabaseSync(dbPath(future));
    db.prepare("UPDATE schema_meta SET version = 99 WHERE id = 1").run();
    db.close();
    assert.throws(() => ControlStore.open({ stateDir: future }), /Unsupported schema version 99/);
  } finally {
    cleanup(future);
  }
});

test("WP002-IR-007 R5: real v3 legacy JSONL reconciles to event_seq order", () => {
  const dir = tempState();
  try {
    const legacy = createExactV3LegacyWithDivergentJsonl(dir);
    // Precondition: legacy JSONL order differs from eventual backfill order.
    assert.notDeepEqual(legacy.jsonlAppendOrder, legacy.eventIdsByBackfillOrder);
    const before = readFileSync(eventsJsonlPath(dir), "utf8");
    assert.equal(before.includes("event_seq"), false);

    const store = ControlStore.open({ stateDir: dir });
    assert.equal(store.schemaVersion(), SCHEMA_VERSION);
    const sqlite = store.listEvents();
    assert.equal(sqlite.length, 3);
    assert.deepEqual(
      sqlite.map((e) => e.event_id),
      legacy.eventIdsByBackfillOrder,
    );
    const seqs = sqlite.map((e) => e.event_seq);
    assert.equal(new Set(seqs).size, 3);
    assert.deepEqual(seqs, [1, 2, 3]);

    const jsonl = store.readJsonlEvents();
    assert.equal(jsonl.length, 3);
    assert.deepEqual(
      jsonl.map((e) => String(e.event_id)),
      sqlite.map((e) => e.event_id),
    );
    assert.deepEqual(
      jsonl.map((e) => Number(e.event_seq)),
      sqlite.map((e) => e.event_seq),
    );
    for (const e of jsonl) {
      assert.ok(e.event_seq != null);
      assert.deepEqual(e.payload, legacy.payloads[String(e.event_id)]);
    }
    // Identities/payloads unchanged.
    for (const e of sqlite) {
      assert.deepEqual(e.payload, legacy.payloads[e.event_id]);
    }
    store.close();

    const again = ControlStore.open({ stateDir: dir });
    assert.deepEqual(
      again.listEvents().map((e) => [e.event_id, e.event_seq]),
      again.readJsonlEvents().map((e) => [String(e.event_id), Number(e.event_seq)]),
    );
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-007 R5: interrupted projection rebuild converges on reopen", () => {
  const dir = tempState();
  try {
    createExactV3LegacyWithDivergentJsonl(dir);
    // First open migrates + rebuilds.
    const store = ControlStore.open({ stateDir: dir });
    store.close();

    // Simulate crash after schema=4 but with divergent/corrupt projection left behind.
    writeFileSync(
      eventsJsonlPath(dir),
      `${JSON.stringify({
        event_id: "evt_z",
        ts: "2026-02-01T00:00:00.000Z",
        event_type: "work.created",
        project_id: "prj_v3",
        work_id: "wrk_v3",
        payload: { mark: "z", n: 2 },
      })}\n`,
      "utf8",
    );
    // Also leave a stale temp file as if rename failed mid-flight.
    writeFileSync(`${eventsJsonlPath(dir)}.tmp`, "partial\n", "utf8");

    const reopen = ControlStore.open({ stateDir: dir });
    const sqlite = reopen.listEvents();
    const jsonl = reopen.readJsonlEvents();
    assert.equal(sqlite.length, 3);
    assert.equal(jsonl.length, 3);
    assert.deepEqual(
      jsonl.map((e) => [String(e.event_id), Number(e.event_seq)]),
      sqlite.map((e) => [e.event_id, e.event_seq]),
    );
    assert.equal(new Set(jsonl.map((e) => String(e.event_id))).size, 3);
    reopen.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-007 R6: malformed destination JSONL rebuilds from SQLite", () => {
  const dir = tempState();
  try {
    // Valid schema-v4 authoritative state.
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("malformed");
    store.createWork(project.project_id, "w1", {
      taskType: "sum_two",
      taskInput: { a: 1, b: 2, expected: 3, bug: false },
    });
    store.createWork(project.project_id, "w2", {
      taskType: "sum_two",
      taskInput: { a: 3, b: 4, expected: 7, bug: false },
    });
    const before = store.listEvents();
    assert.ok(before.length >= 3);
    const expectedIds = before.map((e) => e.event_id);
    const expectedSeqs = before.map((e) => e.event_seq);
    store.close();

    // Replace destination events.jsonl itself with syntactically malformed JSON.
    writeFileSync(
      eventsJsonlPath(dir),
      "{not-json\nthis is garbage\n",
      "utf8",
    );
    writeFileSync(`${eventsJsonlPath(dir)}.tmp`, "stale-tmp\n", "utf8");
    writeFileSync(`${eventsJsonlPath(dir)}.aside`, "stale-aside\n", "utf8");

    const reopen = ControlStore.open({ stateDir: dir });
    assert.equal(reopen.schemaVersion(), SCHEMA_VERSION);
    const sqlite = reopen.listEvents();
    const jsonl = reopen.readJsonlEvents();
    assert.deepEqual(
      sqlite.map((e) => e.event_id),
      expectedIds,
    );
    assert.deepEqual(
      sqlite.map((e) => e.event_seq),
      expectedSeqs,
    );
    assert.deepEqual(
      jsonl.map((e) => [String(e.event_id), Number(e.event_seq)]),
      sqlite.map((e) => [e.event_id, e.event_seq]),
    );
    assert.equal(new Set(jsonl.map((e) => String(e.event_id))).size, jsonl.length);
    for (const e of jsonl) {
      assert.ok(typeof e.event_seq === "number");
      assert.ok(e.event_type);
    }
    reopen.close();

    const again = ControlStore.open({ stateDir: dir });
    assert.deepEqual(
      again.listEvents().map((e) => [e.event_id, e.event_seq]),
      again.readJsonlEvents().map((e) => [String(e.event_id), Number(e.event_seq)]),
    );
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("lease-expired unfinished attempt becomes ABANDONED", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const claimed = store.claimNextWork("w1", 1000, t0)!;
    const att = store.beginExecutionAttempt(
      claimed.work_id,
      claimed.lease_token!,
      "w1",
      t0,
    );
    store.recoverExpiredLeases(new Date("2026-01-01T00:00:01.000Z"));
    const after = store.listAttempts(claimed.work_id).find((a) => a.attempt_id === att.attempt_id)!;
    assert.equal(after.attempt_outcome, "ABANDONED");
    assert.ok(after.finished_at);
    assert.equal(store.getWork(claimed.work_id)?.state, "QUEUED");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("stale lease cannot finish/repair/fail/complete", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const claimed = store.claimNextWork("stale", 1000, t0)!;
    const staleToken = claimed.lease_token!;
    const att = store.beginExecutionAttempt(
      claimed.work_id,
      staleToken,
      "stale",
      t0,
    );
    store.recoverExpiredLeases(new Date("2026-01-01T00:00:01.000Z"));
    const fresh = store.claimNextWork(
      "fresh",
      5000,
      new Date("2026-01-01T00:00:02.000Z"),
    )!;
    const now = new Date("2026-01-01T00:00:02.500Z");
    assert.throws(
      () =>
        store.finishExecutionAttempt({
          workId: claimed.work_id,
          leaseToken: staleToken,
          workerId: "stale",
          attemptId: att.attempt_id,
          executionOk: true,
          result: {},
          verificationStatus: "PASS",
          verificationDetail: "x",
        }, now),
      (e: unknown) => e instanceof ControlError && e.code === "STALE_LEASE",
    );
    assert.throws(
      () =>
        store.failWork(claimed.work_id, staleToken, "stale", "x", now),
      (e: unknown) => e instanceof ControlError && e.code === "STALE_LEASE",
    );
    assert.throws(
      () =>
        store.completeWork(claimed.work_id, staleToken, "stale", now),
      (e: unknown) => e instanceof ControlError && e.code === "STALE_LEASE",
    );
    const done = runOwnedWork(store, fresh, { now });
    assert.equal(done.completed, true);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("worker crash after claim: abandon + recover + complete", async () => {
  const dir = tempState();
  try {
    const setup = ControlStore.open({ stateDir: dir });
    const work = seedSumTwo(setup, { a: 2, b: 3, expected: 5, bug: true }, 1);
    setup.close();

    const child = spawn(
      process.execPath,
      [runOnceJs, dir, "worker-crash", "80", "60000"],
      { windowsHide: true },
    );
    const claimedLine = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("timeout"));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        buf += String(chunk);
        const line = buf.split(/\r?\n/).find((l) => l.startsWith("CLAIMED "));
        if (line) {
          clearTimeout(timer);
          resolve(line);
        }
      });
      child.on("error", reject);
    });
    assert.match(claimedLine, new RegExp(work.work_id));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 120));

    const resume = ControlStore.open({ stateDir: dir });
    resume.recoverExpiredLeases(new Date());
    assert.equal(resume.getWork(work.work_id)?.state, "QUEUED");
    const result = runOnce(resume, "worker-resume", 5000);
    assert.ok(result);
    assert.equal(result.work.work_id, work.work_id);
    assert.equal(result.completed, true);
    resume.close();
  } finally {
    cleanup(dir);
  }
});

test("attempt/result history persists across reopen", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const work = seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: true }, 1);
    runOnce(store, "w1", 5000);
    store.close();
    const again = ControlStore.open({ stateDir: dir });
    const attempts = again.listAttempts(work.work_id);
    assert.equal(attempts[0].repair_applied, true);
    assert.equal(attempts[1].verification_status, "PASS");
    assert.equal(again.getWork(work.work_id)?.state, "COMPLETED");
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("repair changes failing cause (not force verifier PASS)", () => {
  const execBug = sumTwoHandler.execute({ a: 2, b: 3, expected: 5, bug: true });
  assert.equal(
    sumTwoHandler.verify({ a: 2, b: 3, expected: 5, bug: true }, execBug).status,
    "FAIL",
  );
  const repaired = sumTwoHandler.repair({ a: 2, b: 3, expected: 5, bug: true })!;
  assert.equal(repaired.nextInput.bug, false);
  assert.equal(
    sumTwoHandler.verify(repaired.nextInput, sumTwoHandler.execute(repaired.nextInput))
      .status,
    "PASS",
  );
});

function workLifecycleTypes(store: ControlStore, workId: string): string[] {
  return store
    .listEvents()
    .filter((e) => e.work_id === workId)
    .map((e) => e.event_type);
}

test("WP002-IR-007: fixed-timestamp lifecycle has deterministic event_seq order", () => {
  const dir = tempState();
  const fixed = new Date("2026-06-01T12:00:00.000Z");
  try {
    const store = ControlStore.open({
      stateDir: dir,
      clock: () => fixed,
    });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const result = runOnce(store, "w1", 5000, { now: fixed });
    assert.ok(result?.completed);
    const types = workLifecycleTypes(store, result.work.work_id);
    const expected = [
      "work.created",
      "work.claimed",
      "work.attempt_started",
      "work.execution_started",
      "work.execution_finished",
      "work.attempt_finished",
      "work.verification_passed",
      "work.completed",
    ];
    assert.deepEqual(types, expected);

    for (let i = 0; i < 20; i += 1) {
      const againDir = tempState();
      try {
        const s = ControlStore.open({
          stateDir: againDir,
          clock: () => fixed,
        });
        seedSumTwo(s, { a: 2, b: 3, expected: 5, bug: false });
        const r = runOnce(s, "w1", 5000, { now: fixed });
        assert.ok(r?.completed);
        assert.deepEqual(workLifecycleTypes(s, r.work.work_id), expected);
        const sqlite = s.listEvents().map((e) => ({
          seq: e.event_seq,
          type: e.event_type,
          id: e.event_id,
        }));
        const jsonl = s.readJsonlEvents().map((e) => ({
          seq: Number(e.event_seq),
          type: String(e.event_type),
          id: String(e.event_id),
        }));
        assert.deepEqual(jsonl, sqlite);
        s.close();
      } finally {
        cleanup(againDir);
      }
    }
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-007: SETUP_ERROR and EXEC_ERROR event order truthful", () => {
  const dir = tempState();
  const fixed = new Date("2026-06-01T13:00:00.000Z");
  try {
    const store = ControlStore.open({
      stateDir: dir,
      clock: () => fixed,
    });
    const project = store.createProject("ord");
    const bare = store.createWork(project.project_id, "nospec");
    const setup = runOnce(store, "w1", 5000, { now: fixed });
    assert.ok(setup?.failed);
    assert.deepEqual(workLifecycleTypes(store, bare.work_id), [
      "work.created",
      "work.claimed",
      "work.attempt_started",
      "work.attempt_finished",
      "work.failed",
    ]);

    const taskType = "exec_ord";
    registerTaskHandler({
      taskType,
      execute: () => {
        throw new Error("x");
      },
      verify: () => ({ status: "PASS", detail: "n/a" }),
      repair: () => null,
    });
    const work = store.createWork(project.project_id, "ex", {
      taskType,
      taskInput: {},
      maxRepairs: 0,
    });
    const ex = runOnce(store, "w2", 5000, { now: fixed });
    assert.ok(ex?.failed);
    const types = workLifecycleTypes(store, work.work_id);
    assert.deepEqual(types, [
      "work.created",
      "work.claimed",
      "work.attempt_started",
      "work.execution_started",
      "work.execution_finished",
      "work.attempt_finished",
      "work.failed",
    ]);
    unregisterTaskHandler(taskType);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-007: FAIL→repair→pass order and SQLite/JSONL parity", () => {
  const dir = tempState();
  const fixed = new Date("2026-06-01T14:00:00.000Z");
  try {
    const store = ControlStore.open({
      stateDir: dir,
      clock: () => fixed,
    });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: true }, 1);
    const result = runOnce(store, "w1", 5000, { now: fixed });
    assert.ok(result?.completed);
    const types = workLifecycleTypes(store, result.work.work_id);
    assert.ok(types.indexOf("work.verification_failed") > -1);
    assert.ok(types.indexOf("work.repair_applied") > -1);
    assert.ok(
      types.indexOf("work.verification_failed") <
        types.indexOf("work.repair_applied"),
    );
    assert.ok(
      types.indexOf("work.execution_finished") <
        types.indexOf("work.attempt_finished"),
    );
    assert.ok(
      types.indexOf("work.attempt_finished") <
        types.indexOf("work.verification_failed"),
    );
    const sqlite = store.listEvents().map((e) => e.event_seq);
    const jsonl = store.readJsonlEvents().map((e) => Number(e.event_seq));
    assert.deepEqual(jsonl, sqlite);
    assert.equal(new Set(sqlite).size, sqlite.length);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("WP002-IR-010: cyclic execution result → RESULT_ERROR + FAILED", () => {
  const dir = tempState();
  const taskType = "cyclic_result";
  registerTaskHandler({
    taskType,
    execute: () => {
      const output: Record<string, unknown> = { n: 1 };
      (output as { self?: unknown }).self = output;
      return { ok: true, output };
    },
    verify: () => ({ status: "PASS", detail: "ok" }),
    repair: () => null,
  });
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("cyc");
    const work = store.createWork(project.project_id, "t", {
      taskType,
      taskInput: {},
      maxRepairs: 0,
    });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result?.failed);
    assert.equal(result.work.state, "FAILED");
    assert.match(result.work.failure_reason ?? "", /^result_error:/);
    const att = store.listAttempts(work.work_id)[0];
    assert.ok(att.finished_at);
    assert.equal(att.attempt_outcome, "RESULT_ERROR");
    assert.equal(att.execution_ok, true);
    assert.equal(att.result_json, null);
    const types = workLifecycleTypes(store, work.work_id);
    assert.ok(types.includes("work.execution_started"));
    assert.ok(types.includes("work.execution_finished"));
    assert.ok(types.includes("work.attempt_finished"));
    assert.equal(types.includes("work.completed"), false);
    assert.equal(runOnce(store, "w2", 5000), null);
    store.close();

    const again = ControlStore.open({ stateDir: dir });
    assert.equal(again.getWork(work.work_id)?.state, "FAILED");
    assert.equal(
      again.listAttempts(work.work_id)[0].attempt_outcome,
      "RESULT_ERROR",
    );
    assert.equal(runOnce(again, "w3", 5000), null);
    again.close();
  } finally {
    unregisterTaskHandler(taskType);
    cleanup(dir);
  }
});
