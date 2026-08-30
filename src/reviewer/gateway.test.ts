import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlError } from "../control/types.js";
import {
  PROTOCOL_V1,
  type CanonicalEnvelope,
  type ControlRequestBody,
} from "../control/protocol.js";
import type { CycleSnapshot } from "../control/adapters.js";
import { GatewayReviewerAdapter } from "./gateway.js";
import { ScriptedReviewerBinding } from "./fixtures/scripted-binding.js";
import { FakeReviewerAdapter } from "../control/fixtures/fake-adapters.js";
import {
  createReviewerWorkspace,
  verifyReviewerWorkspaceImmutable,
} from "./workspace.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(repoPath: string): string {
  mkdirSync(repoPath, { recursive: true });
  git(["init"], repoPath);
  git(["config", "user.email", "test@owata.local"], repoPath);
  git(["config", "user.name", "OWATA Test"], repoPath);
  writeFileSync(join(repoPath, "STATUS.md"), "STATUS=BROKEN\n", "utf8");
  writeFileSync(
    join(repoPath, "ACCEPTANCE.md"),
    "expected: STATUS=READY\n",
    "utf8",
  );
  git(["add", "."], repoPath);
  git(["commit", "-m", "init broken candidate"], repoPath);
  return git(["rev-parse", "HEAD"], repoPath);
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function makeCycle(targetSha: string): CycleSnapshot {
  return {
    cycle_id: "cyc_g",
    state: "DISPATCHING_REVIEW",
    work_package_ref: "WP-003-B2-S1",
    base_sha: targetSha,
    latest_candidate_sha: targetSha,
    accepted_candidate_sha: null,
    current_request_id: "req_g",
    policy: { on_builder_candidate: "AWAIT_PC" },
    policy_authorized_by_decision_id: null,
    recovery_target_request_id: null,
    recovery_lineage_id: null,
    recovery_reason: null,
  };
}

function makeRequest(
  targetSha: string | null,
): CanonicalEnvelope<ControlRequestBody> {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_req_g",
    kind: "control_request",
    cycle_id: "cyc_g",
    request_id: "req_g",
    from_role: "program_control",
    to_role: "reviewer",
    created_at: "2026-08-30T00:00:00.000Z",
    body: {
      action: "REVIEW",
      target_role: "reviewer",
      work_package_ref: "WP-003-B2-S1",
      base_sha: targetSha,
      target_sha: targetSha,
      authoritative_references: ["work-packages/WP-003"],
      required_capabilities: [
        "repository_read",
        "exact_checkout",
        "command_execution",
      ],
      expected_result_kind: "reviewer_result",
      stop_condition: "return to program_control",
      authorized_by_decision_id: null,
      authorized_finding_ids: [],
      retry_of_request_id: null,
    },
  };
}

function passEnvelope(targetSha: string): unknown {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_rev_ok",
    kind: "reviewer_result",
    cycle_id: "cyc_g",
    request_id: "req_g",
    from_role: "reviewer",
    to_role: "program_control",
    created_at: "2026-08-30T00:01:00.000Z",
    body: {
      target_sha: targetSha,
      verdict: "PASS",
      findings: [],
      evidence_refs: [],
    },
  };
}

test("real reviewer path never falls back to fake", async () => {
  const binding = new ScriptedReviewerBinding();
  binding.probeResult = { ok: false, authReady: false, detail: "down" };
  const root = mkdtempSync(join(tmpdir(), "owata-rev-nofake-"));
  try {
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    assert.equal(adapter.identity.adapter_id, "gateway-reviewer");
    assert.notEqual(adapter.identity.adapter_id, "fake-reviewer");
    const fake = new FakeReviewerAdapter([], {
      id: () => "x",
      now: () => "t",
    });
    assert.notEqual(adapter.identity.adapter_id, fake.identity.adapter_id);
    // preflight blocks; start never called
    const pre = adapter.preflight([
      "repository_read",
      "exact_checkout",
      "command_execution",
    ]);
    assert.equal(pre.ok, false);
    assert.equal(binding.startCount, 0);
  } finally {
    cleanup(root);
  }
});

test("missing target_sha fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-miss-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(null),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "TARGET_SHA_REQUIRED",
    );
    assert.equal(binding.startCount, 0);
  } finally {
    cleanup(root);
  }
});

test("unresolved target fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-unres-"));
  try {
    initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
          request: makeRequest("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "TARGET_SHA_UNRESOLVED",
    );
    assert.equal(binding.startCount, 0);
  } finally {
    cleanup(root);
  }
});

test("authReady=false blocks runtime spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-auth-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.probeResult = {
      ok: true,
      authReady: false,
      runtimeVersion: "x",
      detail: "not logged in",
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    const pre = adapter.preflight([
      "repository_read",
      "exact_checkout",
      "command_execution",
    ]);
    assert.equal(pre.ok, false);
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "CREDENTIAL_UNAVAILABLE",
    );
    assert.equal(binding.startCount, 0);
  } finally {
    cleanup(root);
  }
});

test("exact clean review accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-ok-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      binding.writeResult(attempt.resultEnvelopePath, passEnvelope(sha));
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    const result = (await adapter.review({
      cycle: makeCycle(sha),
      request: makeRequest(sha),
      dispatch: {
        dispatch_id: "d1",
        attempt_number: 1,
        fence_token: "f1",
        lease_expires_at: "2099-01-01T00:00:00.000Z",
      },
    })) as { kind: string; body: { verdict: string; target_sha: string } };
    assert.equal(result.kind, "reviewer_result");
    assert.equal(result.body.verdict, "PASS");
    assert.equal(result.body.target_sha, sha);
    assert.equal(binding.startCount, 1);
  } finally {
    cleanup(root);
  }
});

test("wrong target result rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-wrong-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      binding.writeResult(
        attempt.resultEnvelopePath,
        passEnvelope("0000000000000000000000000000000000000001"),
      );
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "RESULT_STALE",
    );
  } finally {
    cleanup(root);
  }
});

test("dirty reviewer workspace rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-dirty-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      writeFileSync(
        join(attempt.worktreePath, "STATUS.md"),
        "STATUS=MUTATED\n",
        "utf8",
      );
      binding.writeResult(attempt.resultEnvelopePath, passEnvelope(sha));
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "WORKSPACE_DIRTY",
    );
  } finally {
    cleanup(root);
  }
});

test("source mutation rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-mut-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      writeFileSync(
        join(attempt.worktreePath, "STATUS.md"),
        "STATUS=MUTATED\n",
        "utf8",
      );
      git(["add", "STATUS.md"], attempt.worktreePath);
      git(["commit", "-m", "evil"], attempt.worktreePath);
      binding.writeResult(attempt.resultEnvelopePath, passEnvelope(sha));
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "SOURCE_MUTATION",
    );
  } finally {
    cleanup(root);
  }
});

test("malformed result rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-mal-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      writeFileSync(attempt.resultEnvelopePath, "not-json{{{", "utf8");
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(() =>
      adapter.review({
        cycle: makeCycle(sha),
        request: makeRequest(sha),
        dispatch: {
          dispatch_id: "d1",
          attempt_number: 1,
          fence_token: "f1",
          lease_expires_at: "2099-01-01T00:00:00.000Z",
        },
      }),
    );
  } finally {
    cleanup(root);
  }
});

test("request mismatch rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-reqmis-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      const env = passEnvelope(sha) as {
        request_id: string;
      };
      env.request_id = "wrong_req";
      binding.writeResult(attempt.resultEnvelopePath, env);
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "RESULT_STALE",
    );
  } finally {
    cleanup(root);
  }
});

test("cycle mismatch rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-cycmis-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      const env = passEnvelope(sha) as { cycle_id: string };
      env.cycle_id = "wrong_cycle";
      binding.writeResult(attempt.resultEnvelopePath, env);
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath: join(root, "repo"),
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d1",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "RESULT_STALE",
    );
  } finally {
    cleanup(root);
  }
});

test("workspace create + immutability helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-ws-"));
  try {
    const repo = join(root, "repo");
    const sha = initRepo(repo);
    const ws = createReviewerWorkspace({
      repoPath: repo,
      targetSha: sha,
      workspacesRoot: join(root, "ws"),
      cycleId: "c",
      requestId: "r",
      dispatchId: "d",
      attemptNumber: 1,
    });
    assert.equal(ws.headAtCheckout, sha);
    const proof = verifyReviewerWorkspaceImmutable({
      workspacePath: ws.workspacePath,
      targetSha: sha,
      treeHashBefore: ws.treeHashBefore,
    });
    assert.equal(proof.trackedClean, true);
    assert.equal(proof.noNewCommit, true);
  } finally {
    cleanup(root);
  }
});
