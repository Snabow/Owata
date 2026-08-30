import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ControlStore, HandoffStore, dbPath, eventsJsonlPath } from "./control/index.js";
import { main } from "./cli.js";
import {
  formatStatus,
  nextAuthorityForCycleState,
  readStatusSnapshot,
} from "./status.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliJs = join(root, "dist", "cli.js");

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-status-"));
}

test("nextAuthorityForCycleState mapping", () => {
  assert.equal(nextAuthorityForCycleState("AWAITING_PC"), "program_control");
  assert.equal(nextAuthorityForCycleState("DISPATCHING_PC"), "program_control");
  assert.equal(nextAuthorityForCycleState("DISPATCHING_BUILD"), "builder");
  assert.equal(nextAuthorityForCycleState("DISPATCHING_REVIEW"), "reviewer");
  assert.equal(nextAuthorityForCycleState("HUMAN_GATE"), "human");
  assert.equal(nextAuthorityForCycleState("RECOVERY_REQUIRED"), "program_control");
  assert.equal(nextAuthorityForCycleState("ACCEPTED"), "none");
  assert.equal(nextAuthorityForCycleState("ABORTED"), "none");
  assert.equal(nextAuthorityForCycleState(null), "program_control");
});

test("ABSENT: no control.sqlite reports NO_DURABLE_STATE without creating DB", () => {
  const dir = tempState();
  try {
    const snap = readStatusSnapshot(dir);
    assert.equal(snap.kind, "ABSENT");
    if (snap.kind !== "ABSENT") return;
    assert.equal(snap.statusCode, "NO_DURABLE_STATE");
    const text = formatStatus(snap);
    assert.match(text, /Durable state: ABSENT/);
    assert.match(text, /Status: NO_DURABLE_STATE/);
    assert.doesNotMatch(text, /Bootstrap control core/);
    assert.doesNotMatch(text, /State: Genesis/);
    assert.equal(existsSync(dbPath(dir)), false);
    assert.equal(existsSync(eventsJsonlPath(dir)), false);
    const names = readdirSync(dir);
    assert.ok(!names.some((n) => n.includes("control.sqlite")));
    assert.ok(!names.some((n) => n.includes("events.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PRESENT: project with no cycle", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const project = store.createProject("status-proj");
    store.close();

    const snap = readStatusSnapshot(dir);
    assert.equal(snap.kind, "PRESENT");
    if (snap.kind !== "PRESENT") return;
    assert.equal(snap.projectId, project.project_id);
    assert.equal(snap.projectName, "status-proj");
    assert.equal(snap.cycleId, null);
    assert.equal(snap.nextAuthority, "program_control");
    assert.match(formatStatus(snap), /Latest cycle: none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PRESENT: cycle fields and next authority by state", () => {
  const cases: Array<{
    state:
      | "AWAITING_PC"
      | "DISPATCHING_BUILD"
      | "DISPATCHING_REVIEW"
      | "HUMAN_GATE"
      | "RECOVERY_REQUIRED"
      | "ACCEPTED"
      | "ABORTED";
    authority: string;
  }> = [
    { state: "AWAITING_PC", authority: "program_control" },
    { state: "DISPATCHING_BUILD", authority: "builder" },
    { state: "DISPATCHING_REVIEW", authority: "reviewer" },
    { state: "HUMAN_GATE", authority: "human" },
    { state: "RECOVERY_REQUIRED", authority: "program_control" },
    { state: "ACCEPTED", authority: "none" },
    { state: "ABORTED", authority: "none" },
  ];

  for (const c of cases) {
    const dir = tempState();
    try {
      const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
      const handoff = new HandoffStore(store);
      const project = store.createProject(`p-${c.state}`);
      const cycle = handoff.createCycle({
        projectId: project.project_id,
        workPackageRef: "WP-003-STATUS",
        baseSha: "a".repeat(40),
      });
      if (c.state !== "AWAITING_PC") {
        handoff.transition(cycle.cycle_id, c.state, {
          current_request_id: c.state === "ACCEPTED" || c.state === "ABORTED" ? null : "req_x",
          latest_candidate_sha: "b".repeat(40),
          accepted_candidate_sha: c.state === "ACCEPTED" ? "b".repeat(40) : null,
          recovery_reason: c.state === "RECOVERY_REQUIRED" ? "dispatch_retry_budget_exhausted" : null,
        });
      }
      store.close();

      const snap = readStatusSnapshot(dir);
      assert.equal(snap.kind, "PRESENT");
      if (snap.kind !== "PRESENT") continue;
      assert.equal(snap.cycleState, c.state === "AWAITING_PC" ? "AWAITING_PC" : c.state);
      assert.equal(snap.nextAuthority, c.authority);
      assert.equal(snap.workPackageRef, "WP-003-STATUS");
      const text = formatStatus(snap);
      assert.match(text, new RegExp(`Next authority: ${c.authority}`));
      assert.doesNotMatch(text, /Bootstrap control core/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("multiple cycles: latest by updated_at then cycle_id", () => {
  const dir = tempState();
  try {
    let t = Date.parse("2026-08-30T00:00:00.000Z");
    const store = ControlStore.open({
      stateDir: dir,
      idFactory: seqIds(),
      clock: () => {
        t += 1000;
        return new Date(t);
      },
    });
    const handoff = new HandoffStore(store);
    const project = store.createProject("multi");
    const older = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-OLD",
      baseSha: "a".repeat(40),
    });
    const newer = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-NEW",
      baseSha: "a".repeat(40),
    });
    // Bump older to an earlier updated_at explicitly via transition on newer last
    handoff.transition(newer.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: "req_new",
    });
    store.close();

    const snap = readStatusSnapshot(dir);
    assert.equal(snap.kind, "PRESENT");
    if (snap.kind !== "PRESENT") return;
    assert.equal(snap.cycleId, newer.cycle_id);
    assert.equal(snap.workPackageRef, "WP-NEW");
    assert.notEqual(snap.cycleId, older.cycle_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session-independent reopen recovers same cycle identity", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("reopen");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-REOPEN",
      baseSha: "c".repeat(40),
    });
    handoff.transition(cycle.cycle_id, "DISPATCHING_REVIEW", {
      current_request_id: "req_review",
      latest_candidate_sha: "d".repeat(40),
    });
    const id = cycle.cycle_id;
    store.close();

    const first = readStatusSnapshot(dir);
    const second = readStatusSnapshot(dir);
    assert.equal(first.kind, "PRESENT");
    assert.equal(second.kind, "PRESENT");
    if (first.kind !== "PRESENT" || second.kind !== "PRESENT") return;
    assert.equal(first.cycleId, id);
    assert.equal(second.cycleId, id);
    assert.equal(first.cycleState, "DISPATCHING_REVIEW");
    assert.equal(second.nextAuthority, "reviewer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt durable state fails closed without bootstrap stub", () => {
  const dir = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dbPath(dir), "not-a-sqlite-database\n", "utf8");
    assert.throws(() => readStatusSnapshot(dir));
    process.env.OWATA_STATE_DIR = dir;
    const code = main(["node", "owata", "status"]);
    delete process.env.OWATA_STATE_DIR;
    assert.equal(code, 1);
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI status respects OWATA_STATE_DIR and ABSENT proof", () => {
  const dir = tempState();
  try {
    const result = spawnSync(process.execPath, [cliJs, "status"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, OWATA_STATE_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Durable state: ABSENT/);
    assert.match(result.stdout, /NO_DURABLE_STATE/);
    assert.doesNotMatch(result.stdout, /Bootstrap control core/);
    assert.equal(existsSync(dbPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI status with seeded durable DB", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("cli-seed");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-CLI",
      baseSha: "e".repeat(40),
    });
    store.close();

    const result = spawnSync(process.execPath, [cliJs, "status"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, OWATA_STATE_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Durable state: PRESENT/);
    assert.match(result.stdout, new RegExp(cycle.cycle_id));
    assert.match(result.stdout, /Work Package: WP-CLI/);
    assert.match(result.stdout, /Next authority: program_control/);
    assert.doesNotMatch(result.stdout, /Bootstrap control core/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
