import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlError,
  ControlStore,
  HandoffStore,
  PROTOCOL_V1,
} from "../control/index.js";
import { parseCanonicalEnvelope } from "../control/protocol.js";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-lease-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort on Windows SQLite locks.
  }
}

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function clockBox(start = "2026-06-01T00:00:00.000Z"): {
  now: () => Date;
  advanceMs: (ms: number) => void;
} {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    advanceMs: (delta) => {
      ms += delta;
    },
  };
}

function openHarness(dir: string, clock = clockBox()) {
  const store = ControlStore.open({
    stateDir: dir,
    clock: clock.now,
    idFactory: seqIds(),
  });
  const handoff = new HandoffStore(store);
  return { store, handoff, clock };
}

function persistBuilderRequest(
  handoff: HandoffStore,
  store: ControlStore,
  cycleId: string,
  requestId: string,
): void {
  handoff.persistEnvelope({
    protocol: PROTOCOL_V1,
    envelope_id: store.nextId("env"),
    kind: "control_request",
    cycle_id: cycleId,
    request_id: requestId,
    from_role: "program_control",
    to_role: "builder",
    created_at: store.now().toISOString(),
    body: {
      action: "BUILD",
      target_role: "builder",
      work_package_ref: "WP-003",
      base_sha: null,
      target_sha: null,
      authoritative_references: ["work-packages/WP-003"],
      required_capabilities: ["repository_read"],
      expected_result_kind: "builder_result",
      stop_condition: null,
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
      retry_of_request_id: null,
    },
  });
}

test("renewDispatchLease extends CLAIMED dispatch lease", () => {
  const dir = tempState();
  try {
    const { store, handoff, clock } = openHarness(dir);
    const project = store.createProject("lease-renew");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const requestId = "req_builder_1";
    persistBuilderRequest(handoff, store, cycle.cycle_id, requestId);
    handoff.transition(cycle.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: requestId,
    });
    const dispatch = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId,
      targetRole: "builder",
      owner: "worker",
      leaseMs: 5_000,
    });
    const before = dispatch.lease_expires_at;
    clock.advanceMs(2_000);
    const renewed = handoff.renewDispatchLease(
      dispatch.dispatch_id,
      dispatch.fence_token,
      10_000,
    );
    assert.equal(renewed.state, "CLAIMED");
    assert.notEqual(renewed.lease_expires_at, before);
    assert.ok(Date.parse(renewed.lease_expires_at) > clock.now().getTime());
    const event = store
      .listEvents()
      .find((e) => e.event_type === "cycle.lease_renewed");
    assert.ok(event);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("renewDispatchLease rejects stale fence token", () => {
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    const project = store.createProject("lease-stale");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const requestId = "req_builder_1";
    persistBuilderRequest(handoff, store, cycle.cycle_id, requestId);
    handoff.transition(cycle.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: requestId,
    });
    const dispatch = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId,
      targetRole: "builder",
      owner: "worker",
      leaseMs: 5_000,
    });
    assert.throws(
      () =>
        handoff.renewDispatchLease(dispatch.dispatch_id, "wrong_fence", 5_000),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("renewDispatchLease rejects ACCEPTED dispatch", () => {
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    const project = store.createProject("lease-accepted");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const requestId = "req_builder_1";
    persistBuilderRequest(handoff, store, cycle.cycle_id, requestId);
    handoff.transition(cycle.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: requestId,
    });
    const dispatch = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId,
      targetRole: "builder",
      owner: "worker",
      leaseMs: 5_000,
    });
    handoff.acceptResult({
      dispatchId: dispatch.dispatch_id,
      fenceToken: dispatch.fence_token,
      envelope: parseCanonicalEnvelope({
        protocol: PROTOCOL_V1,
        envelope_id: store.nextId("env"),
        kind: "builder_result",
        cycle_id: cycle.cycle_id,
        request_id: requestId,
        from_role: "builder",
        to_role: "program_control",
        created_at: store.now().toISOString(),
        body: {
          status: "CANDIDATE_READY",
          candidate_sha: "sha",
          evidence_refs: [],
          notes: null,
        },
      }),
    });
    assert.throws(
      () =>
        handoff.renewDispatchLease(dispatch.dispatch_id, dispatch.fence_token, 5_000),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("renewDispatchLease rejects REJECTED dispatch", () => {
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    const project = store.createProject("lease-rejected");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const requestId = "req_builder_1";
    persistBuilderRequest(handoff, store, cycle.cycle_id, requestId);
    handoff.transition(cycle.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: requestId,
    });
    const dispatch = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId,
      targetRole: "builder",
      owner: "worker",
      leaseMs: 5_000,
    });
    handoff.rejectResult({
      dispatchId: dispatch.dispatch_id,
      fenceToken: dispatch.fence_token,
      failureClass: "RUNTIME_ERROR",
      detail: "failed",
    });
    assert.throws(
      () =>
        handoff.renewDispatchLease(dispatch.dispatch_id, dispatch.fence_token, 5_000),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("renewDispatchLease rejects EXPIRED lease", () => {
  const dir = tempState();
  try {
    const { store, handoff, clock } = openHarness(dir);
    const project = store.createProject("lease-expired");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const requestId = "req_builder_1";
    persistBuilderRequest(handoff, store, cycle.cycle_id, requestId);
    handoff.transition(cycle.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: requestId,
    });
    const dispatch = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId,
      targetRole: "builder",
      owner: "worker",
      leaseMs: 1_000,
    });
    clock.advanceMs(2_000);
    assert.throws(
      () =>
        handoff.renewDispatchLease(dispatch.dispatch_id, dispatch.fence_token, 5_000),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("renewDispatchLease atomic race: intervening state change yields STALE_FENCE and no renew event", () => {
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    const project = store.createProject("lease-race");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
    });
    const requestId = "req_builder_1";
    persistBuilderRequest(handoff, store, cycle.cycle_id, requestId);
    handoff.transition(cycle.cycle_id, "DISPATCHING_BUILD", {
      current_request_id: requestId,
    });
    const dispatch = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId,
      targetRole: "builder",
      owner: "worker",
      leaseMs: 5_000,
    });
    // Simulate recovery/supersession race: authoritative state leaves CLAIMED.
    store.db
      .prepare(`UPDATE dispatches SET state = 'RECOVERED' WHERE dispatch_id = ?`)
      .run(dispatch.dispatch_id);
    const before = store
      .listEvents()
      .filter((e) => e.event_type === "cycle.lease_renewed").length;
    assert.throws(
      () =>
        handoff.renewDispatchLease(
          dispatch.dispatch_id,
          dispatch.fence_token,
          5_000,
        ),
      (err: unknown) => err instanceof ControlError && err.code === "STALE_FENCE",
    );
    const after = store
      .listEvents()
      .filter((e) => e.event_type === "cycle.lease_renewed").length;
    assert.equal(after, before);
    store.close();
  } finally {
    cleanup(dir);
  }
});
