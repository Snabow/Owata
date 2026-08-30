import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  removeReviewerWorkspace,
  type ReviewerWorkspaceCleanupProof,
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
  git(["add", "."], repoPath);
  git(["commit", "-m", "init"], repoPath);
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
    cycle_id: "cyc_f04",
    state: "DISPATCHING_REVIEW",
    work_package_ref: "WP-003-B2-S1",
    base_sha: targetSha,
    latest_candidate_sha: targetSha,
    accepted_candidate_sha: null,
    current_request_id: "req_f04",
    policy: { on_builder_candidate: "AWAIT_PC" },
    policy_authorized_by_decision_id: null,
    recovery_target_request_id: null,
    recovery_lineage_id: null,
    recovery_reason: null,
  };
}

function makeRequest(
  targetSha: string,
): CanonicalEnvelope<ControlRequestBody> {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_req_f04",
    kind: "control_request",
    cycle_id: "cyc_f04",
    request_id: "req_f04",
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
    envelope_id: "env_rev_f04",
    kind: "reviewer_result",
    cycle_id: "cyc_f04",
    request_id: "req_f04",
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

test("F04 success: result returned only after cleanup proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-f04-ok-"));
  try {
    const repoPath = join(root, "repo");
    const sha = initRepo(repoPath);
    const workspacesRoot = join(root, "ws");
    const binding = new ScriptedReviewerBinding();
    let observedWorkspace: string | null = null;
    binding.onStart = (attempt) => {
      observedWorkspace = attempt.worktreePath;
      binding.writeResult(attempt.resultEnvelopePath, passEnvelope(sha));
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath,
      workspacesRoot,
    });
    await adapter.refreshProbe();
    const result = (await adapter.review({
      cycle: makeCycle(sha),
      request: makeRequest(sha),
      dispatch: {
        dispatch_id: "d_f04_ok",
        attempt_number: 1,
        fence_token: "f1",
        lease_expires_at: "2099-01-01T00:00:00.000Z",
      },
    })) as { kind: string; body: { verdict: string } };
    assert.equal(result.kind, "reviewer_result");
    assert.equal(result.body.verdict, "PASS");

    const proofPath = join(
      root,
      "state",
      "execution",
      "d_f04_ok",
      "workspace-cleanup-proof.json",
    );
    assert.equal(existsSync(proofPath), true);
    const proof = JSON.parse(
      readFileSync(proofPath, "utf8"),
    ) as ReviewerWorkspaceCleanupProof;
    assert.equal(proof.workspace_removed, true);
    assert.equal(proof.registered_after_cleanup, false);
    assert.equal(proof.path_exists_after_cleanup, false);
    assert.equal(proof.remove_attempted, true);

    assert.ok(observedWorkspace);
    const wsPath = observedWorkspace as string;
    assert.equal(existsSync(wsPath), false);
    const list = git(["worktree", "list", "--porcelain"], repoPath);
    assert.equal(
      list
        .toLowerCase()
        .includes(wsPath.replace(/\\/g, "/").toLowerCase()),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test("F04 cleanup command failure: result NOT accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-f04-fail-"));
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
      cleanupWorkspace: () => {
        throw new ControlError(
          "REVIEWER_WORKSPACE_CLEANUP_FAILED",
          "injected cleanup failure",
        );
      },
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d_f04_fail",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError &&
        err.code === "REVIEWER_WORKSPACE_CLEANUP_FAILED",
    );
    // Diagnostic pending result may remain; authority must not have returned.
    const pending = join(
      root,
      "state",
      "execution",
      "d_f04_fail",
      "reviewer-result-pending.json",
    );
    assert.equal(existsSync(pending), true);
  } finally {
    cleanup(root);
  }
});

test("F04 cleanup verification failure: fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-f04-verify-"));
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
      cleanupWorkspace: () => ({
        workspace_id: "injected",
        workspace_path: join(root, "ws", "still-there"),
        remove_attempted: true,
        registered_after_cleanup: true,
        path_exists_after_cleanup: true,
        workspace_removed: false,
      }),
    });
    await adapter.refreshProbe();
    await assert.rejects(
      () =>
        adapter.review({
          cycle: makeCycle(sha),
          request: makeRequest(sha),
          dispatch: {
            dispatch_id: "d_f04_verify",
            attempt_number: 1,
            fence_token: "f1",
            lease_expires_at: "2099-01-01T00:00:00.000Z",
          },
        }),
      (err: unknown) =>
        err instanceof ControlError &&
        err.code === "REVIEWER_WORKSPACE_CLEANUP_FAILED",
    );
    const proofPath = join(
      root,
      "state",
      "execution",
      "d_f04_verify",
      "workspace-cleanup-proof.json",
    );
    assert.equal(existsSync(proofPath), true);
    const pending = join(
      root,
      "state",
      "execution",
      "d_f04_verify",
      "reviewer-result-pending.json",
    );
    assert.equal(existsSync(pending), true);
  } finally {
    cleanup(root);
  }
});

test("F04 removeReviewerWorkspace: successful cleanup proof", () => {
  const root = mkdtempSync(join(tmpdir(), "owata-f04-rm-"));
  try {
    const repoPath = join(root, "repo");
    const sha = initRepo(repoPath);
    const workspacePath = join(root, "wt");
    git(["worktree", "add", "--detach", workspacePath, sha], repoPath);
    assert.equal(existsSync(workspacePath), true);
    const proof = removeReviewerWorkspace({
      repoPath,
      workspacePath,
      workspaceId: "wt-test",
    });
    assert.equal(proof.workspace_removed, true);
    assert.equal(proof.registered_after_cleanup, false);
    assert.equal(proof.path_exists_after_cleanup, false);
    assert.equal(existsSync(workspacePath), false);
  } finally {
    cleanup(root);
  }
});

test("F04 reviewer failure path still removes workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-f04-rej-"));
  try {
    const repoPath = join(root, "repo");
    const sha = initRepo(repoPath);
    const binding = new ScriptedReviewerBinding();
    let observedWorkspace: string | null = null;
    binding.onStart = (attempt) => {
      observedWorkspace = attempt.worktreePath;
      writeFileSync(attempt.resultEnvelopePath, "not-json{{{", "utf8");
    };
    const adapter = new GatewayReviewerAdapter({
      binding,
      stateDir: join(root, "state"),
      repoPath,
      workspacesRoot: join(root, "ws"),
    });
    await adapter.refreshProbe();
    await assert.rejects(() =>
      adapter.review({
        cycle: makeCycle(sha),
        request: makeRequest(sha),
        dispatch: {
          dispatch_id: "d_f04_rej",
          attempt_number: 1,
          fence_token: "f1",
          lease_expires_at: "2099-01-01T00:00:00.000Z",
        },
      }),
    );
    assert.ok(observedWorkspace);
    assert.equal(existsSync(observedWorkspace!), false);
    const proofPath = join(
      root,
      "state",
      "execution",
      "d_f04_rej",
      "workspace-cleanup-proof.json",
    );
    assert.equal(existsSync(proofPath), true);
  } finally {
    cleanup(root);
  }
});
