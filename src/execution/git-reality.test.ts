import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyCandidateGitReality } from "./git-reality.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string, readme: string): string {
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), readme, "utf8");
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

test("verifyCandidateGitReality accepts clean descendant commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-git-ok-"));
  try {
    const base = initRepo(dir, "base\n");
    writeFileSync(join(dir, "README.md"), "candidate\n", "utf8");
    git(["commit", "-am", "candidate"], dir);
    const candidate = git(["rev-parse", "HEAD"], dir);
    assert.doesNotThrow(() =>
      verifyCandidateGitReality({
        repoPath: dir,
        worktreePath: dir,
        baseSha: base,
        candidateSha: candidate,
      }),
    );
  } finally {
    cleanup(dir);
  }
});

test("verifyCandidateGitReality rejects dirty worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-git-dirty-"));
  try {
    const base = initRepo(dir, "base\n");
    writeFileSync(join(dir, "README.md"), "dirty\n", "utf8");
    git(["commit", "-am", "candidate"], dir);
    const candidate = git(["rev-parse", "HEAD"], dir);
    writeFileSync(join(dir, "README.md"), "uncommitted\n", "utf8");
    assert.throws(
      () =>
        verifyCandidateGitReality({
          repoPath: dir,
          worktreePath: dir,
          baseSha: base,
          candidateSha: candidate,
        }),
      /porcelain changes/,
    );
  } finally {
    cleanup(dir);
  }
});

test("verifyCandidateGitReality rejects non-ancestor base", () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-git-anc-"));
  try {
    const base = initRepo(dir, "base\n");
    writeFileSync(join(dir, "README.md"), "branch-a\n", "utf8");
    git(["commit", "-am", "a"], dir);
    const candidate = git(["rev-parse", "HEAD"], dir);
    git(["checkout", "--detach", base], dir);
    writeFileSync(join(dir, "README.md"), "branch-b\n", "utf8");
    git(["commit", "-am", "b"], dir);
    const other = git(["rev-parse", "HEAD"], dir);
    assert.throws(
      () =>
        verifyCandidateGitReality({
          repoPath: dir,
          worktreePath: dir,
          baseSha: other,
          candidateSha: candidate,
        }),
      /not an ancestor/,
    );
  } finally {
    cleanup(dir);
  }
});
