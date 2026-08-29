import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ControlError, ControlStore } from "./index.js";
import { eventsJsonlPath, dbPath } from "./db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const claimHoldJs = join(root, "dist", "control", "fixtures", "claim-and-hold.js");
const claimOnceJs = join(root, "dist", "control", "fixtures", "claim-once.js");

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-wp001-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("sqlite init: WAL, schema version, idempotent reopen", () => {
  const dir = tempState();
  try {
    const a = ControlStore.open({ stateDir: dir });
    assert.equal(a.walEnabled(), true);
    assert.equal(a.schemaVersion(), 1);
    assert.equal(existsSync(dbPath(dir)), true);
    a.close();

    const b = ControlStore.open({ stateDir: dir });
    assert.equal(b.walEnabled(), true);
    assert.equal(b.schemaVersion(), 1);
    b.close();
  } finally {
    cleanup(dir);
  }
});

test("persistence: project and work survive reopen", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("demo");
    const work = store.createWork(project.project_id, "task-1");
    store.close();

    const again = ControlStore.open({ stateDir: dir });
    assert.deepEqual(again.getProject(project.project_id), project);
    const loaded = again.getWork(work.work_id);
    assert.ok(loaded);
    assert.equal(loaded.work_id, work.work_id);
    assert.equal(loaded.state, "QUEUED");
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("queue: claim moves QUEUED to RUNNING with lease", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("demo");
    const work = store.createWork(project.project_id, "task-1");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const claimed = store.claimNextWork("worker-a", 5000, now);
    assert.ok(claimed);
    assert.equal(claimed.work_id, work.work_id);
    assert.equal(claimed.state, "RUNNING");
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.lease_owner, "worker-a");
    assert.ok(claimed.lease_token);
    assert.equal(claimed.lease_expires_at, "2026-01-01T00:00:05.000Z");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("concurrency: only one of two processes claims the same work", async () => {
  const dir = tempState();
  try {
    const setup = ControlStore.open({ stateDir: dir });
    const project = setup.createProject("demo");
    setup.createWork(project.project_id, "only-one");
    setup.close();

    const run = (workerId: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [claimOnceJs, dir, workerId, "5000"],
          { windowsHide: true },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => {
          out += String(c);
        });
        child.stderr.on("data", (c) => {
          err += String(c);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`claim-once exit ${code}: stdout=${out} stderr=${err}`));
          } else resolve(out.trim());
        });
      });

    const [a, b] = await Promise.all([run("w1"), run("w2")]);
    const got = [a, b].filter((line) => line.startsWith("GOT "));
    const none = [a, b].filter((line) => line === "NONE");
    assert.equal(got.length, 1);
    assert.equal(none.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("lease fencing: stale/expired lease cannot complete; current can", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("demo");
    store.createWork(project.project_id, "task");
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const claimed = store.claimNextWork("worker-a", 1000, t0);
    assert.ok(claimed);

    assert.throws(
      () =>
        store.completeWork(
          claimed.work_id,
          "wrong-token",
          "worker-a",
          new Date("2026-01-01T00:00:00.500Z"),
        ),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_LEASE",
    );

    assert.throws(
      () =>
        store.completeWork(
          claimed.work_id,
          claimed.lease_token!,
          "worker-a",
          new Date("2026-01-01T00:00:01.000Z"),
        ),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_LEASE",
    );

    const done = store.completeWork(
      claimed.work_id,
      claimed.lease_token!,
      "worker-a",
      new Date("2026-01-01T00:00:00.500Z"),
    );
    assert.equal(done.state, "COMPLETED");
    assert.equal(done.lease_token, null);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("recovery: expired RUNNING becomes QUEUED with same work_id", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("demo");
    store.createWork(project.project_id, "task");
    const claimed = store.claimNextWork(
      "worker-a",
      1000,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    assert.ok(claimed);
    const recovered = store.recoverExpiredLeases(
      new Date("2026-01-01T00:00:01.000Z"),
    );
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].work_id, claimed.work_id);
    assert.equal(recovered[0].state, "QUEUED");
    assert.equal(recovered[0].lease_owner, null);
    assert.equal(recovered[0].lease_token, null);
    assert.equal(recovered[0].attempt, 1);

    const again = store.claimNextWork(
      "worker-b",
      1000,
      new Date("2026-01-01T00:00:02.000Z"),
    );
    assert.ok(again);
    assert.equal(again.work_id, claimed.work_id);
    assert.equal(again.attempt, 2);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("events: sqlite + jsonl; restart flush without duplication", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("demo");
    const work = store.createWork(project.project_id, "task");
    const events = store.listEvents();
    assert.ok(events.some((e) => e.event_type === "project.created"));
    assert.ok(events.some((e) => e.event_type === "work.created"));

    const jsonl = store.readJsonlEvents();
    assert.equal(jsonl.length, events.length);

    // Simulate crash gap: SQLite has unflushed event, JSONL missing it.
    const pendingId = "evt_pending_gap_test";
    store.db
      .prepare(
        `INSERT INTO events (
           event_id, ts, event_type, project_id, work_id, payload, jsonl_flushed
         ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        pendingId,
        "2026-01-01T00:00:09.000Z",
        "work.created",
        project.project_id,
        work.work_id,
        JSON.stringify({ synthetic: true }),
      );
    store.close();

    const before = readFileSync(eventsJsonlPath(dir), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(before.some((l) => l.includes(pendingId)), false);

    const again = ControlStore.open({ stateDir: dir });
    const after = again.readJsonlEvents();
    const matches = after.filter((e) => e.event_id === pendingId);
    assert.equal(matches.length, 1);

    // Second flush must not duplicate.
    again.flushEventJsonl();
    const after2 = again.readJsonlEvents().filter((e) => e.event_id === pendingId);
    assert.equal(after2.length, 1);
    again.close();

    // Already-projected event: mark unflushed again but leave JSONL line;
    // reopen must mark flushed without duplicating.
    const store3 = ControlStore.open({ stateDir: dir });
    store3.db
      .prepare("UPDATE events SET jsonl_flushed = 0 WHERE event_id = ?")
      .run(pendingId);
    store3.close();
    const store4 = ControlStore.open({ stateDir: dir });
    const againIds = store4
      .readJsonlEvents()
      .filter((e) => e.event_id === pendingId);
    assert.equal(againIds.length, 1);
    const row = store4.db
      .prepare("SELECT jsonl_flushed FROM events WHERE event_id = ?")
      .get(pendingId) as { jsonl_flushed: number };
    assert.equal(row.jsonl_flushed, 1);
    store4.close();
  } finally {
    cleanup(dir);
  }
});

test("crash recovery: kill claimant process, recover same work_id, complete", async () => {
  const dir = tempState();
  try {
    const setup = ControlStore.open({ stateDir: dir });
    const project = setup.createProject("crash-demo");
    const work = setup.createWork(project.project_id, "must-survive");
    setup.close();

    const child = spawn(
      process.execPath,
      [claimHoldJs, dir, "worker-crash", "80"],
      { windowsHide: true },
    );

    const claimedLine = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("timeout waiting for claim"));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        buf += String(chunk);
        const line = buf
          .split(/\r?\n/)
          .find((l) => l.startsWith("CLAIMED ") && !l.includes("none"));
        if (line) {
          clearTimeout(timer);
          resolve(line);
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const parts = claimedLine.split(" ");
    const claimedWorkId = parts[1];
    assert.equal(claimedWorkId, work.work_id);

    // Verify RUNNING while child still holds the DB connection.
    const mid = ControlStore.open({ stateDir: dir });
    assert.equal(mid.getWork(work.work_id)?.state, "RUNNING");
    mid.close();

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("close", () => resolve()));

    // Wait for short lease to expire.
    await new Promise((r) => setTimeout(r, 120));

    const resume = ControlStore.open({ stateDir: dir });
    const recovered = resume.recoverExpiredLeases(new Date());
    assert.ok(recovered.some((w) => w.work_id === work.work_id));
    const queued = resume.getWork(work.work_id);
    assert.ok(queued);
    assert.equal(queued.state, "QUEUED");
    assert.equal(queued.work_id, work.work_id);

    const claimed = resume.claimNextWork("worker-resume", 5000);
    assert.ok(claimed);
    assert.equal(claimed.work_id, work.work_id);
    assert.equal(claimed.state, "RUNNING");

    const done = resume.completeWork(
      claimed.work_id,
      claimed.lease_token!,
      "worker-resume",
    );
    assert.equal(done.state, "COMPLETED");
    resume.close();
  } finally {
    cleanup(dir);
  }
});

test("illegal transition: complete QUEUED fails explicitly", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const project = store.createProject("demo");
    const work = store.createWork(project.project_id, "task");
    assert.throws(
      () => store.completeWork(work.work_id, "x", "w"),
      (err: unknown) =>
        err instanceof ControlError && err.code === "ILLEGAL_TRANSITION",
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});
