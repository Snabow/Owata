import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ControlError,
  ControlStore,
  HandoffStore,
  SCHEMA_VERSION,
  dbPath,
  eventsJsonlPath,
  parseCycleState,
} from "./control/index.js";
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

function assertFailClosedNoMutation(dir: string, beforeNames: string[]): void {
  assert.throws(() => readStatusSnapshot(dir), ControlError);
  process.env.OWATA_STATE_DIR = dir;
  const code = main(["node", "owata", "status"]);
  delete process.env.OWATA_STATE_DIR;
  assert.equal(code, 1);
  assert.equal(existsSync(eventsJsonlPath(dir)), false);
  const after = readdirSync(dir);
  assert.ok(!after.includes("events.jsonl"));
  for (const name of after) {
    if (
      (name.endsWith("-wal") || name.endsWith("-shm")) &&
      !beforeNames.includes(name)
    ) {
      assert.fail(`status retained new artifact ${name}`);
    }
  }
  for (const name of beforeNames) {
    assert.ok(after.includes(name), `expected retained ${name}`);
  }
}

function seedHistoricalV1(stateDir: string): void {
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
    `INSERT INTO projects VALUES ('prj_v1','hist-v1','ACTIVE','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
  ).run();
  db.close();
}

test("parseCycleState accepts canonical values and rejects unknown", () => {
  assert.equal(parseCycleState("AWAITING_PC"), "AWAITING_PC");
  assert.equal(parseCycleState("ABORTED"), "ABORTED");
  assert.throws(() => parseCycleState("CORRUPT_STATE"), /Invalid cycle state/);
  assert.throws(() => parseCycleState(null), /Invalid cycle state/);
});

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
          current_request_id:
            c.state === "ACCEPTED" || c.state === "ABORTED" ? null : "req_x",
          latest_candidate_sha: "b".repeat(40),
          accepted_candidate_sha: c.state === "ACCEPTED" ? "b".repeat(40) : null,
          recovery_reason:
            c.state === "RECOVERY_REQUIRED"
              ? "dispatch_retry_budget_exhausted"
              : null,
        });
      }
      store.close();

      const snap = readStatusSnapshot(dir);
      assert.equal(snap.kind, "PRESENT");
      if (snap.kind !== "PRESENT") continue;
      assert.equal(
        snap.cycleState,
        c.state === "AWAITING_PC" ? "AWAITING_PC" : c.state,
      );
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

test("zero-byte control.sqlite fails closed without mutation", () => {
  const dir = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dbPath(dir), Buffer.alloc(0));
    const before = readdirSync(dir);
    assertFailClosedNoMutation(dir, before);
    assert.equal(statSync(dbPath(dir)).size, 0);
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("random bytes control.sqlite fails closed without PRESENT", () => {
  const dir = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(dbPath(dir), "not-a-sqlite-database\n", "utf8");
    const before = readdirSync(dir);
    assertFailClosedNoMutation(dir, before);
    const result = spawnSync(process.execPath, [cliJs, "status"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, OWATA_STATE_DIR: dir },
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Durable state: PRESENT/);
    assert.doesNotMatch(result.stdout, /Bootstrap control core/);
    assert.doesNotMatch(result.stdout, /State: Genesis/);
    assert.match(result.stderr, /owata status failed/);
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-OWATA SQLite fails closed", () => {
  const dir = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath(dir));
    db.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY);");
    db.close();
    assertFailClosedNoMutation(dir, readdirSync(dir));
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing schema_meta id=1 fails closed", () => {
  const dir = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY,
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
        project_id TEXT NOT NULL,
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
    db.close();
    assert.throws(() => readStatusSnapshot(dir), /schema_meta row id=1/);
    process.env.OWATA_STATE_DIR = dir;
    assert.equal(main(["node", "owata", "status"]), 1);
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupported schema version fails closed", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    store.createProject("future");
    store.close();
    const db = new DatabaseSync(dbPath(dir));
    db.prepare("UPDATE schema_meta SET version = 99 WHERE id = 1").run();
    db.close();
    assert.throws(
      () => readStatusSnapshot(dir),
      /Unsupported schema version 99/,
    );
    process.env.OWATA_STATE_DIR = dir;
    assert.equal(main(["node", "owata", "status"]), 1);
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown persisted cycle state fails closed without invalid next authority", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("corrupt-state");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-CORRUPT",
      baseSha: "a".repeat(40),
    });
    store.close();

    const db = new DatabaseSync(dbPath(dir));
    db.prepare("UPDATE cycles SET state = ? WHERE cycle_id = ?").run(
      "CORRUPT_STATE",
      cycle.cycle_id,
    );
    db.close();

    assert.throws(() => readStatusSnapshot(dir), /Invalid cycle state/);
    const result = spawnSync(process.execPath, [cliJs, "status"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, OWATA_STATE_DIR: dir },
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Durable state: PRESENT/);
    assert.doesNotMatch(result.stdout, /Next authority: CORRUPT_STATE/);
    assert.doesNotMatch(result.stdout, /Cycle state: CORRUPT_STATE/);
    assert.match(result.stderr, /Invalid cycle state/);
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed v1 core schema columns fail closed without mutation", () => {
  const dir = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE schema_meta (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL
      );
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      CREATE TABLE work_items (
        work_id TEXT PRIMARY KEY,
        blob TEXT
      );
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        data TEXT
      );
      INSERT INTO schema_meta (id, version) VALUES (1, 1);
    `);
    db.close();
    const before = readFileSync(dbPath(dir));
    assert.throws(
      () => readStatusSnapshot(dir),
      /missing required column/,
    );
    process.env.OWATA_STATE_DIR = dir;
    assert.equal(main(["node", "owata", "status"]), 1);
    delete process.env.OWATA_STATE_DIR;
    assert.equal(existsSync(eventsJsonlPath(dir)), false);
    assert.deepEqual(readFileSync(dbPath(dir)), before);
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version-aware required columns reject later-version gaps", () => {
  const cases: Array<{ version: number; alter: (db: DatabaseSync) => void; match: RegExp }> = [
    {
      version: 2,
      alter: (db) => {
        db.exec(`
          CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
          CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE work_items (work_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_token TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE events (event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, event_type TEXT NOT NULL, project_id TEXT, work_id TEXT, payload TEXT NOT NULL, jsonl_flushed INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE work_attempts (attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, worker_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, execution_ok INTEGER, result_json TEXT, verification_status TEXT, verification_detail TEXT, repair_applied INTEGER NOT NULL DEFAULT 0, repair_note TEXT, created_at TEXT NOT NULL);
        `);
        db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 2)").run();
      },
      match: /missing required column 'task_type'/,
    },
    {
      version: 3,
      alter: (db) => {
        db.exec(`
          CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
          CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE work_items (work_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_token TEXT, lease_expires_at TEXT, task_type TEXT, task_input TEXT, repair_count INTEGER NOT NULL DEFAULT 0, max_repairs INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE events (event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, event_type TEXT NOT NULL, project_id TEXT, work_id TEXT, payload TEXT NOT NULL, jsonl_flushed INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE work_attempts (attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, worker_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, execution_ok INTEGER, result_json TEXT, verification_status TEXT, verification_detail TEXT, repair_applied INTEGER NOT NULL DEFAULT 0, repair_note TEXT, created_at TEXT NOT NULL);
        `);
        db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 3)").run();
      },
      match: /missing required column 'failure_reason'|missing required column 'attempt_outcome'/,
    },
    {
      version: 4,
      alter: (db) => {
        db.exec(`
          CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
          CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE work_items (work_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_token TEXT, lease_expires_at TEXT, task_type TEXT, task_input TEXT, repair_count INTEGER NOT NULL DEFAULT 0, max_repairs INTEGER NOT NULL DEFAULT 1, failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE events (event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, event_type TEXT NOT NULL, project_id TEXT, work_id TEXT, payload TEXT NOT NULL, jsonl_flushed INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE work_attempts (attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, worker_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, execution_ok INTEGER, result_json TEXT, verification_status TEXT, verification_detail TEXT, repair_applied INTEGER NOT NULL DEFAULT 0, repair_note TEXT, attempt_outcome TEXT, created_at TEXT NOT NULL);
        `);
        db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 4)").run();
      },
      match: /missing required column 'event_seq'/,
    },
  ];

  for (const c of cases) {
    const dir = tempState();
    try {
      mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(dbPath(dir));
      c.alter(db);
      db.close();
      assert.throws(() => readStatusSnapshot(dir), c.match);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // v5: declared current schema missing cycles.state fails closed.
  const dir = tempState();
  try {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath(dir));
    db.exec(`
      CREATE TABLE schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE work_items (work_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_token TEXT, lease_expires_at TEXT, task_type TEXT, task_input TEXT, repair_count INTEGER NOT NULL DEFAULT 0, max_repairs INTEGER NOT NULL DEFAULT 1, failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE events (event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, event_type TEXT NOT NULL, project_id TEXT, work_id TEXT, payload TEXT NOT NULL, jsonl_flushed INTEGER NOT NULL DEFAULT 0, event_seq INTEGER);
      CREATE TABLE work_attempts (attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, worker_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, execution_ok INTEGER, result_json TEXT, verification_status TEXT, verification_detail TEXT, repair_applied INTEGER NOT NULL DEFAULT 0, repair_note TEXT, attempt_outcome TEXT, created_at TEXT NOT NULL);
      CREATE TABLE cycles (cycle_id TEXT PRIMARY KEY);
      CREATE TABLE envelopes (envelope_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT, from_role TEXT NOT NULL, to_role TEXT, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE dispatches (dispatch_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, fence_token TEXT NOT NULL, owner TEXT NOT NULL, target_role TEXT NOT NULL, state TEXT NOT NULL, lease_expires_at TEXT NOT NULL, result_envelope_id TEXT, failure_class TEXT, failure_detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE human_gates (gate_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, decision_envelope_id TEXT NOT NULL, purpose TEXT NOT NULL, allowed_choices_json TEXT NOT NULL, state TEXT NOT NULL, selected_choice TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, ?)").run(
      SCHEMA_VERSION,
    );
    db.close();
    assert.throws(
      () => readStatusSnapshot(dir),
      /missing required column/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supported historical OWATA schema remains migratable via status", () => {
  const dir = tempState();
  try {
    seedHistoricalV1(dir);
    const snap = readStatusSnapshot(dir);
    assert.equal(snap.kind, "PRESENT");
    if (snap.kind !== "PRESENT") return;
    assert.equal(snap.projectId, "prj_v1");
    assert.equal(snap.projectName, "hist-v1");
    assert.equal(snap.nextAuthority, "program_control");
    const verify = ControlStore.open({ stateDir: dir });
    assert.equal(verify.schemaVersion(), SCHEMA_VERSION);
    verify.close();
  } finally {
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
