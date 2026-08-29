import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attemptWorktreeId,
  createAttemptWorktree,
  removeAttemptWorktree,
} from "./worktree.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): string {
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "init"], dir);
  return git(["rev-parse", "HEAD"], dir);
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort on Windows file locks.
  }
}

test("createAttemptWorktree isolates attempts by identity", () => {
  const root = mkdtempSync(join(tmpdir(), "owata-wt-root-"));
  const repoPath = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  try {
    mkdirSync(repoPath, { recursive: true });
    const baseSha = initRepo(repoPath);
    const a1 = createAttemptWorktree({
      repoPath,
      baseSha,
      worktreesRoot,
      cycleId: "cyc_1",
      requestId: "req_1",
      dispatchId: "dsp_1",
      attemptNumber: 1,
    });
    const a2 = createAttemptWorktree({
      repoPath,
      baseSha,
      worktreesRoot,
      cycleId: "cyc_1",
      requestId: "req_1",
      dispatchId: "dsp_2",
      attemptNumber: 2,
    });
    assert.notEqual(a1.worktreePath, a2.worktreePath);
    assert.equal(existsSync(join(a1.worktreePath, "README.md")), true);
    assert.equal(existsSync(join(a2.worktreePath, "README.md")), true);
    writeFileSync(join(a1.worktreePath, "README.md"), "attempt1\n", "utf8");
    const a1Head = git(["rev-parse", "HEAD"], a1.worktreePath);
    const a2Head = git(["rev-parse", "HEAD"], a2.worktreePath);
    assert.equal(a1Head, a2Head);
    assert.notEqual(
      attemptWorktreeId({
        cycleId: "cyc_1",
        requestId: "req_1",
        dispatchId: "dsp_1",
        attemptNumber: 1,
      }),
      attemptWorktreeId({
        cycleId: "cyc_1",
        requestId: "req_1",
        dispatchId: "dsp_2",
        attemptNumber: 2,
      }),
    );
    removeAttemptWorktree({ repoPath, worktreePath: a1.worktreePath });
    removeAttemptWorktree({ repoPath, worktreePath: a2.worktreePath });
    assert.equal(existsSync(a1.worktreePath), false);
  } finally {
    cleanup(root);
  }
});
