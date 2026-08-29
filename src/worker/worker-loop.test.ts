import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ControlError, ControlStore } from "../control/index.js";
import { runOnce, runOwnedWork, sumTwoHandler } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runOnceJs = join(root, "dist", "worker", "fixtures", "run-once.js");

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-wp002-"));
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

test("verifier is separate: execution ok + verify FAIL does not complete", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: true }, 0);
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.completed, false);
    assert.equal(result.work.state, "RUNNING");
    assert.equal(result.reason, "repair_budget_exhausted");
    const attempts = store.listAttempts(result.work.work_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].execution_ok, true);
    assert.equal(attempts[0].verification_status, "FAIL");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("execution ok + verify PASS → COMPLETED", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false });
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.completed, true);
    assert.equal(result.work.state, "COMPLETED");
    const attempts = store.listAttempts(result.work.work_id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].verification_status, "PASS");
    const types = store.listEvents().map((e) => e.event_type);
    assert.ok(types.includes("work.execution_started"));
    assert.ok(types.includes("work.execution_finished"));
    assert.ok(types.includes("work.verification_passed"));
    assert.ok(types.includes("work.completed"));
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("fail → repair → pass → COMPLETED (production loop)", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    const work = seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: true }, 1);
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.completed, true);
    assert.equal(result.work.state, "COMPLETED");
    assert.equal(result.work.work_id, work.work_id);
    assert.equal(result.work.repair_count, 1);
    assert.equal(result.work.task_input?.bug, false);

    const attempts = store.listAttempts(work.work_id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].verification_status, "FAIL");
    assert.equal(attempts[1].verification_status, "PASS");

    const types = store.listEvents().map((e) => e.event_type);
    assert.ok(types.includes("work.verification_failed"));
    assert.ok(types.includes("work.repair_applied"));
    assert.ok(types.includes("work.verification_passed"));
    assert.ok(types.includes("work.completed"));
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("repair budget is bounded", () => {
  const dir = tempState();
  try {
    // Handler repair clears bug; re-introduce by using maxRepairs=0 so first fail stops.
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 1, b: 1, expected: 2, bug: true }, 0);
    const result = runOnce(store, "w1", 5000);
    assert.ok(result);
    assert.equal(result.completed, false);
    assert.equal(result.reason, "repair_budget_exhausted");
    assert.equal(store.listAttempts(result.work.work_id).length, 1);

    // With budget 1, repair happens once; if we force bug again after repair via
    // a custom path — sum_two repair clears bug so second attempt passes.
    // Boundedness: applying repair beyond max throws.
    const project = store.createProject("bound");
    const w = store.createWork(project.project_id, "x", {
      taskType: "sum_two",
      taskInput: { a: 1, b: 1, expected: 2, bug: true },
      maxRepairs: 1,
    });
    const claimed = store.claimNextWork("w2", 5000)!;
    store.applyRepair({
      workId: claimed.work_id,
      leaseToken: claimed.lease_token!,
      workerId: "w2",
      nextInput: { a: 1, b: 1, expected: 2, bug: true },
      note: "first",
    });
    assert.throws(
      () =>
        store.applyRepair({
          workId: claimed.work_id,
          leaseToken: claimed.lease_token!,
          workerId: "w2",
          nextInput: { a: 1, b: 1, expected: 2, bug: false },
          note: "second",
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "REPAIR_BUDGET",
    );
    assert.equal(w.work_id, claimed.work_id);
    store.close();
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
    const before = store.listAttempts(work.work_id);
    store.close();

    const again = ControlStore.open({ stateDir: dir });
    const after = again.listAttempts(work.work_id);
    assert.equal(after.length, before.length);
    assert.equal(after[0].verification_status, "FAIL");
    assert.equal(after[1].verification_status, "PASS");
    assert.equal(again.getWork(work.work_id)?.state, "COMPLETED");
    again.close();
  } finally {
    cleanup(dir);
  }
});

test("repair changes failing cause (not force verifier PASS)", () => {
  const execBug = sumTwoHandler.execute({ a: 2, b: 3, expected: 5, bug: true });
  const fail = sumTwoHandler.verify(
    { a: 2, b: 3, expected: 5, bug: true },
    execBug,
  );
  assert.equal(fail.status, "FAIL");
  const repaired = sumTwoHandler.repair({ a: 2, b: 3, expected: 5, bug: true });
  assert.ok(repaired);
  assert.equal(repaired.nextInput.bug, false);
  const execOk = sumTwoHandler.execute(repaired.nextInput);
  const pass = sumTwoHandler.verify(repaired.nextInput, execOk);
  assert.equal(pass.status, "PASS");
  // Same verifier against unrepaired output still fails:
  const stillFail = sumTwoHandler.verify(repaired.nextInput, execBug);
  assert.equal(stillFail.status, "FAIL");
});

test("worker crash: unfinished work recoverable; new worker completes", async () => {
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
        reject(new Error("timeout waiting for claim"));
      }, 10000);
      child.stdout.on("data", (chunk) => {
        buf += String(chunk);
        const line = buf.split(/\r?\n/).find((l) => l.startsWith("CLAIMED "));
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

    assert.match(claimedLine, new RegExp(`CLAIMED ${work.work_id}`));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 120));

    const resume = ControlStore.open({ stateDir: dir });
    const recovered = resume.recoverExpiredLeases(new Date());
    assert.ok(recovered.some((w) => w.work_id === work.work_id));
    assert.equal(resume.getWork(work.work_id)?.state, "QUEUED");

    const result = runOnce(resume, "worker-resume", 5000);
    assert.ok(result);
    assert.equal(result.work.work_id, work.work_id);
    assert.equal(result.completed, true);
    assert.equal(result.work.state, "COMPLETED");
    resume.close();
  } finally {
    cleanup(dir);
  }
});

test("stale lease holder cannot complete after recovery", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    seedSumTwo(store, { a: 2, b: 3, expected: 5, bug: false }, 0);
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const claimed = store.claimNextWork("stale", 1000, t0)!;
    const staleToken = claimed.lease_token!;

    store.recoverExpiredLeases(new Date("2026-01-01T00:00:01.000Z"));
    const again = store.claimNextWork(
      "fresh",
      5000,
      new Date("2026-01-01T00:00:02.000Z"),
    )!;

    assert.throws(
      () =>
        store.completeWork(
          claimed.work_id,
          staleToken,
          "stale",
          new Date("2026-01-01T00:00:02.500Z"),
        ),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_LEASE",
    );

    const done = runOwnedWork(store, again, {
      now: new Date("2026-01-01T00:00:02.500Z"),
    });
    assert.equal(done.completed, true);
    store.close();
  } finally {
    cleanup(dir);
  }
});
