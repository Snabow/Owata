import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ControlError,
  ControlStore,
  dbPath,
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
  rmSync(dir, { recursive: true, force: true });
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
    store.createWork(project.project_id, "bad", {
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
    assert.equal(att.attempt_outcome, "PASS"); // finished as verify PASS but gate rejects
    store.close();
  } finally {
    unregisterTaskHandler(taskType);
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

test("WP002-IR-005 + migration: exact v1→v3 preserves rows; v0/future rejected", () => {
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
