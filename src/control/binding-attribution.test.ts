import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlError, ControlStore, SCHEMA_VERSION } from "./index.js";
import { HandoffStore } from "./handoff.js";
import { dbPath } from "./db.js";
import { parseCanonicalEnvelope, PROTOCOL_V1 } from "./protocol.js";
import { readStatusSnapshot } from "../status.js";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-s4-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

/** Exact historical schema v5 DB with one dispatch row (no binding_id column). */
function createExactV5Database(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(dbPath(stateDir));
  db.exec(`
    CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE work_items (
      work_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_token TEXT, lease_expires_at TEXT,
      task_type TEXT, task_input TEXT, repair_count INTEGER NOT NULL DEFAULT 0,
      max_repairs INTEGER NOT NULL DEFAULT 1, failure_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, event_type TEXT NOT NULL,
      project_id TEXT, work_id TEXT, payload TEXT NOT NULL,
      jsonl_flushed INTEGER NOT NULL DEFAULT 0, event_seq INTEGER
    );
    CREATE TABLE work_attempts (
      attempt_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
      worker_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      execution_ok INTEGER, result_json TEXT, verification_status TEXT, verification_detail TEXT,
      repair_applied INTEGER NOT NULL DEFAULT 0, repair_note TEXT, attempt_outcome TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE cycles (
      cycle_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_package_ref TEXT NOT NULL,
      base_sha TEXT, latest_candidate_sha TEXT, accepted_candidate_sha TEXT, state TEXT NOT NULL,
      current_request_id TEXT, policy_json TEXT NOT NULL,
      policy_authorized_by_decision_id TEXT, recovery_target_request_id TEXT, recovery_lineage_id TEXT,
      max_dispatch_retries INTEGER NOT NULL DEFAULT 3, recovery_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE envelopes (
      envelope_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT,
      from_role TEXT NOT NULL, to_role TEXT, body_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE dispatches (
      dispatch_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, request_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL, fence_token TEXT NOT NULL, owner TEXT NOT NULL,
      target_role TEXT NOT NULL, state TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      result_envelope_id TEXT, failure_class TEXT, failure_detail TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (cycle_id, request_id, attempt_number)
    );
    CREATE TABLE human_gates (
      gate_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, decision_envelope_id TEXT NOT NULL,
      purpose TEXT NOT NULL, allowed_choices_json TEXT NOT NULL, state TEXT NOT NULL,
      selected_choice TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const ts = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 5)").run();
  db.prepare(
    `INSERT INTO projects (project_id, name, state, created_at, updated_at) VALUES ('prj_v5','v5','ACTIVE',?,?)`,
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO cycles (
       cycle_id, project_id, work_package_ref, base_sha, latest_candidate_sha, accepted_candidate_sha,
       state, current_request_id, policy_json, max_dispatch_retries, created_at, updated_at
     ) VALUES ('cyc_v5','prj_v5','WP-004','base',NULL,NULL,'AWAITING_PC',NULL,?,?,?,?)`,
  ).run(JSON.stringify({ on_builder_candidate: "AWAIT_PC" }), 3, ts, ts);
  db.prepare(
    `INSERT INTO dispatches (
       dispatch_id, cycle_id, request_id, attempt_number, fence_token, owner, target_role,
       state, lease_expires_at, result_envelope_id, failure_class, failure_detail, created_at, updated_at
     ) VALUES ('dsp_v5','cyc_v5','req_v5',1,'fence_v5','owner','builder','CLAIMED',?,?,NULL,NULL,?,?)`,
  ).run("2099-01-01T00:00:00.000Z", null, ts, ts);
  db.close();
  writeFileSync(join(stateDir, "events.jsonl"), "", "utf8");
}

function controlRequest(cycleId: string, requestId: string, createdAt: string) {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: `env_${requestId}`,
    kind: "control_request" as const,
    cycle_id: cycleId,
    request_id: requestId,
    from_role: "program_control" as const,
    to_role: "builder" as const,
    created_at: createdAt,
    body: {
      action: "BUILD",
      target_role: "builder",
      work_package_ref: "WP-004-S4",
      base_sha: "base",
      target_sha: null,
      authoritative_references: [],
      required_capabilities: ["repository_read" as const],
      expected_result_kind: "builder_result",
      stop_condition: "CANDIDATE_READY",
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
      retry_of_request_id: null,
    },
  };
}

test("SCHEMA_VERSION is 6 and fresh DB has dispatches.binding_id", () => {
  assert.equal(SCHEMA_VERSION, 6);
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir });
    assert.equal(store.schemaVersion(), 6);
    const cols = store.db
      .prepare(`PRAGMA table_info(dispatches)`)
      .all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "binding_id"));
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("valid v5 DB migrates to v6; historical dispatch binding_id is NULL", () => {
  const dir = tempState();
  try {
    createExactV5Database(dir);
    const store = ControlStore.open({ stateDir: dir });
    assert.equal(store.schemaVersion(), 6);
    const row = store.db
      .prepare(`SELECT dispatch_id, binding_id, state FROM dispatches WHERE dispatch_id = ?`)
      .get("dsp_v5") as { dispatch_id: string; binding_id: string | null; state: string };
    assert.equal(row.dispatch_id, "dsp_v5");
    assert.equal(row.state, "CLAIMED");
    assert.equal(row.binding_id, null);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("declared v6 DB missing binding_id fails STATE_CORRUPT without mutation", () => {
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
      CREATE TABLE cycles (
        cycle_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, work_package_ref TEXT NOT NULL,
        base_sha TEXT, latest_candidate_sha TEXT, accepted_candidate_sha TEXT, state TEXT NOT NULL,
        current_request_id TEXT, policy_json TEXT NOT NULL,
        policy_authorized_by_decision_id TEXT, recovery_target_request_id TEXT, recovery_lineage_id TEXT,
        max_dispatch_retries INTEGER NOT NULL DEFAULT 3, recovery_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE envelopes (envelope_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, kind TEXT NOT NULL, request_id TEXT, from_role TEXT NOT NULL, to_role TEXT, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE dispatches (
        dispatch_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, request_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL, fence_token TEXT NOT NULL, owner TEXT NOT NULL,
        target_role TEXT NOT NULL, state TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
        result_envelope_id TEXT, failure_class TEXT, failure_detail TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE human_gates (
        gate_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, decision_envelope_id TEXT NOT NULL,
        purpose TEXT NOT NULL, allowed_choices_json TEXT NOT NULL, state TEXT NOT NULL,
        selected_choice TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, 6)").run();
    db.close();
    const before = readFileSync(dbPath(dir));
    assert.throws(
      () => readStatusSnapshot(dir),
      /missing required column 'binding_id'|STATE_CORRUPT/,
    );
    assert.deepEqual(readFileSync(dbPath(dir)), before);
  } finally {
    cleanup(dir);
  }
});

test("claimDispatch binding attribution, events, lifecycle, and per-attempt identity", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("s4");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004-S4",
      baseSha: "base",
    });
    const ts = store.now().toISOString();

    const reqId1 = "req_s4_1";
    handoff.persistEnvelope(controlRequest(cycle.cycle_id, reqId1, ts));

    const nullClaim = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId1,
      targetRole: "builder",
      owner: "owner-1",
      leaseMs: 60_000,
    });
    assert.equal(nullClaim.binding_id, null);
    assert.equal(nullClaim.attempt_number, 1);

    const claimedEvents = store
      .listEvents()
      .filter((e) => e.event_type === "cycle.dispatch_claimed");
    const lastClaim = claimedEvents[claimedEvents.length - 1]!;
    assert.equal(
      (lastClaim.payload as { binding_id: string | null }).binding_id,
      null,
    );

    store.db
      .prepare(`UPDATE dispatches SET lease_expires_at = ? WHERE dispatch_id = ?`)
      .run("2000-01-01T00:00:00.000Z", nullClaim.dispatch_id);

    assert.throws(
      () =>
        handoff.claimDispatch({
          cycleId: cycle.cycle_id,
          requestId: reqId1,
          targetRole: "builder",
          owner: "owner-2",
          leaseMs: 60_000,
          bindingId: "",
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "RESULT_INVALID",
    );

    const attributed = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId1,
      targetRole: "builder",
      owner: "owner-2",
      leaseMs: 60_000,
      bindingId: "opaque.provider/binding-alpha",
    });
    assert.equal(attributed.binding_id, "opaque.provider/binding-alpha");
    assert.equal(attributed.attempt_number, 2);

    const attributedEvents = store
      .listEvents()
      .filter((e) => e.event_type === "cycle.dispatch_claimed");
    const attrEvt = attributedEvents[attributedEvents.length - 1]!;
    assert.equal(
      (attrEvt.payload as { binding_id: string | null }).binding_id,
      "opaque.provider/binding-alpha",
    );

    const renewed = handoff.renewDispatchLease(
      attributed.dispatch_id,
      attributed.fence_token,
      60_000,
    );
    assert.equal(renewed.binding_id, "opaque.provider/binding-alpha");

    const reqId2 = "req_s4_2";
    handoff.persistEnvelope(controlRequest(cycle.cycle_id, reqId2, ts));
    const acceptClaim = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId2,
      targetRole: "builder",
      owner: "owner-3",
      leaseMs: 60_000,
      bindingId: "binding-accept",
    });
    const builderEnv = parseCanonicalEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: "env_builder_accept",
      kind: "builder_result",
      cycle_id: cycle.cycle_id,
      request_id: reqId2,
      from_role: "builder",
      to_role: "program_control",
      created_at: ts,
      body: {
        status: "CANDIDATE_READY",
        candidate_sha: "a".repeat(40),
        evidence_refs: [],
        notes: null,
      },
    });
    const accepted = handoff.acceptResult({
      dispatchId: acceptClaim.dispatch_id,
      fenceToken: acceptClaim.fence_token,
      envelope: builderEnv,
    });
    assert.equal(accepted.binding_id, "binding-accept");

    const reqId3 = "req_s4_3";
    handoff.persistEnvelope(controlRequest(cycle.cycle_id, reqId3, ts));
    const rejectClaim = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId3,
      targetRole: "builder",
      owner: "owner-4",
      leaseMs: 60_000,
      bindingId: "binding-reject",
    });
    const rejected = handoff.rejectResult({
      dispatchId: rejectClaim.dispatch_id,
      fenceToken: rejectClaim.fence_token,
      failureClass: "RUNTIME_ERROR",
      detail: "test",
    });
    assert.equal(rejected.binding_id, "binding-reject");

    const reqId4 = "req_s4_4";
    handoff.persistEnvelope(controlRequest(cycle.cycle_id, reqId4, ts));
    const expireClaim = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId4,
      targetRole: "builder",
      owner: "owner-5",
      leaseMs: 60_000,
      bindingId: "binding-expire",
    });
    store.db
      .prepare(`UPDATE dispatches SET lease_expires_at = ? WHERE dispatch_id = ?`)
      .run("2000-01-01T00:00:00.000Z", expireClaim.dispatch_id);
    handoff.recoverExpiredDispatches();
    const expired = handoff.getDispatch(expireClaim.dispatch_id)!;
    assert.equal(expired.state, "EXPIRED");
    assert.equal(expired.binding_id, "binding-expire");

    store.close();
  } finally {
    cleanup(dir);
  }
});

test("claimDispatch coupledEvent commits atomically with claim; rollback drops both (F001)", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("s12-atomic");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004-S12",
      baseSha: "base",
      maxDispatchRetries: 3,
    });
    const ts = store.now().toISOString();
    const reqId = "req_atomic_ok";
    handoff.persistEnvelope(controlRequest(cycle.cycle_id, reqId, ts));

    const claimed = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId,
      targetRole: "builder",
      owner: "owner-atomic",
      leaseMs: 60_000,
      bindingId: "binding-atomic",
      coupledEvent: {
        eventType: "cycle.routing_selected",
        project_id: project.project_id,
        work_id: null,
        payload: {
          cycle_id: cycle.cycle_id,
          request_id: reqId,
          target_role: "builder",
          binding_id: "binding-atomic",
          baseline_binding_id: "binding-atomic",
          automatic_escalation: false,
        },
      },
    });
    assert.equal(claimed.state, "CLAIMED");
    assert.equal(claimed.binding_id, "binding-atomic");

    const claimedEv = store
      .listEvents()
      .filter(
        (e) =>
          e.event_type === "cycle.dispatch_claimed" &&
          (e.payload as { dispatch_id?: string }).dispatch_id ===
            claimed.dispatch_id,
      );
    const selectedEv = store
      .listEvents()
      .filter(
        (e) =>
          e.event_type === "cycle.routing_selected" &&
          (e.payload as { dispatch_id?: string }).dispatch_id ===
            claimed.dispatch_id,
      );
    assert.equal(claimedEv.length, 1);
    assert.equal(selectedEv.length, 1);
    assert.equal(
      (selectedEv[0]!.payload as { binding_id: string }).binding_id,
      "binding-atomic",
    );

    // Mid-write failure: coupledEvent throws after claim writes → full rollback.
    const reqFail = "req_atomic_fail";
    handoff.persistEnvelope(controlRequest(cycle.cycle_id, reqFail, ts));
    const beforeDispatches = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM dispatches WHERE request_id = ?`,
        )
        .get(reqFail) as { n: number }
    ).n;
    const beforeEvents = store.listEvents().length;
    const origAppend = store.appendEvent.bind(store);
    store.appendEvent = ((eventType, args) => {
      if (eventType === "cycle.routing_selected") {
        throw new Error("simulated mid-write failure before COMMIT");
      }
      return origAppend(eventType, args);
    }) as typeof store.appendEvent;

    assert.throws(
      () =>
        handoff.claimDispatch({
          cycleId: cycle.cycle_id,
          requestId: reqFail,
          targetRole: "builder",
          owner: "owner-fail",
          leaseMs: 60_000,
          bindingId: "binding-fail",
          coupledEvent: {
            eventType: "cycle.routing_selected",
            project_id: project.project_id,
            work_id: null,
            payload: {
              cycle_id: cycle.cycle_id,
              request_id: reqFail,
              target_role: "builder",
              binding_id: "binding-fail",
              baseline_binding_id: "binding-fail",
              automatic_escalation: false,
            },
          },
        }),
      /simulated mid-write failure/,
    );

    store.appendEvent = origAppend;
    const afterDispatches = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM dispatches WHERE request_id = ?`,
        )
        .get(reqFail) as { n: number }
    ).n;
    assert.equal(afterDispatches, beforeDispatches);
    assert.equal(store.listEvents().length, beforeEvents);
    assert.equal(
      store
        .listEvents()
        .filter(
          (e) =>
            e.event_type === "cycle.routing_selected" &&
            (e.payload as { request_id?: string }).request_id === reqFail,
        ).length,
      0,
    );
    assert.equal(
      store
        .listEvents()
        .filter(
          (e) =>
            e.event_type === "cycle.dispatch_claimed" &&
            (e.payload as { request_id?: string }).request_id === reqFail,
        ).length,
      0,
    );

    store.close();
  } finally {
    cleanup(dir);
  }
});

test("claimDispatch RETRY_BUDGET recovery remains durable outside success txn (F001)", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("s12-budget");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004-S12",
      baseSha: "base",
      maxDispatchRetries: 1,
    });
    const ts = store.now().toISOString();
    const reqId = "req_budget";
    handoff.persistEnvelope(controlRequest(cycle.cycle_id, reqId, ts));

    const first = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId,
      targetRole: "builder",
      owner: "owner-1",
      leaseMs: 60_000,
      bindingId: "binding-budget",
    });
    store.db
      .prepare(`UPDATE dispatches SET lease_expires_at = ? WHERE dispatch_id = ?`)
      .run("2000-01-01T00:00:00.000Z", first.dispatch_id);

    // If coupledEvent were wrongly inside a shared txn with enterRecovery, a
    // throw here could roll back recovery. Budget path must not enter success txn.
    const origAppend = store.appendEvent.bind(store);
    let routingSelectedAttempts = 0;
    store.appendEvent = ((eventType, args) => {
      if (eventType === "cycle.routing_selected") {
        routingSelectedAttempts += 1;
        throw new Error("coupledEvent must not run on RETRY_BUDGET path");
      }
      return origAppend(eventType, args);
    }) as typeof store.appendEvent;

    assert.throws(
      () =>
        handoff.claimDispatch({
          cycleId: cycle.cycle_id,
          requestId: reqId,
          targetRole: "builder",
          owner: "owner-2",
          leaseMs: 60_000,
          bindingId: "binding-budget-2",
          coupledEvent: {
            eventType: "cycle.routing_selected",
            project_id: project.project_id,
            work_id: null,
            payload: {
              cycle_id: cycle.cycle_id,
              request_id: reqId,
              automatic_escalation: false,
            },
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "RETRY_BUDGET",
    );
    store.appendEvent = origAppend;
    assert.equal(routingSelectedAttempts, 0);

    const recovered = handoff.requireCycle(cycle.cycle_id);
    assert.equal(recovered.state, "RECOVERY_REQUIRED");
    assert.equal(recovered.recovery_reason, "dispatch_retry_budget_exhausted");
    assert.ok(
      store
        .listEvents()
        .some((e) => e.event_type === "cycle.recovery_required"),
    );

    store.close();
    const again = ControlStore.open({ stateDir: dir });
    const h2 = new HandoffStore(again);
    const live = h2.requireCycle(cycle.cycle_id);
    assert.equal(live.state, "RECOVERY_REQUIRED");
    assert.equal(live.recovery_reason, "dispatch_retry_budget_exhausted");
    assert.ok(
      again
        .listEvents()
        .some((e) => e.event_type === "cycle.recovery_required"),
    );
    again.close();
  } finally {
    cleanup(dir);
  }
});
