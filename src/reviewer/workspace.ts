import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/types.js";

/** Full SHA-1 commit object id (lowercase hex). */
const FULL_SHA1 = /^[0-9a-f]{40}$/;

export interface CreateReviewerWorkspaceArgs {
  repoPath: string;
  targetSha: string;
  workspacesRoot: string;
  cycleId: string;
  requestId: string;
  dispatchId: string;
  attemptNumber: number;
}

export interface ReviewerWorkspace {
  workspacePath: string;
  workspaceId: string;
  targetSha: string;
  headAtCheckout: string;
  treeHashBefore: string;
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err != null && "stderr" in err
          ? String((err as { stderr?: Buffer }).stderr ?? err)
          : String(err);
    throw new ControlError(
      "WORKTREE_ERROR",
      `git ${args.join(" ")} failed: ${message}`,
    );
  }
}

/**
 * Fail-closed: target_sha must be a raw full immutable commit object ID.
 * Rejects whitespace, uppercase, HEAD, short prefixes, branches, tags, and
 * revision expressions. No trim/lowercase normalization of the input.
 */
export function assertExactCommitObjectId(targetSha: string): string {
  if (typeof targetSha !== "string" || targetSha.length === 0) {
    throw new ControlError(
      "TARGET_SHA_REQUIRED",
      "target_sha must be a non-empty full commit object id",
    );
  }
  if (!FULL_SHA1.test(targetSha)) {
    throw new ControlError(
      "TARGET_SHA_INVALID",
      `target_sha must be exact lowercase 40-char hex commit id, got: ${JSON.stringify(targetSha)}`,
    );
  }
  return targetSha;
}

export function resolveExactCommitSha(
  repoPath: string,
  targetSha: string,
): string {
  const exact = assertExactCommitObjectId(targetSha);
  let resolved: string;
  try {
    resolved = git(
      ["rev-parse", "--verify", `${exact}^{commit}`],
      repoPath,
    );
  } catch {
    throw new ControlError(
      "TARGET_SHA_UNRESOLVED",
      `target_sha unresolved: ${exact}`,
    );
  }
  if (resolved !== exact) {
    throw new ControlError(
      "TARGET_SHA_MISMATCH",
      `resolved commit ${resolved} != target_sha ${exact}`,
    );
  }
  return resolved;
}

export function reviewerWorkspaceId(args: {
  cycleId: string;
  requestId: string;
  dispatchId: string;
  attemptNumber: number;
}): string {
  return `review__${args.cycleId}__${args.requestId}__${args.dispatchId}__attempt-${args.attemptNumber}`;
}

/**
 * Fresh disposable workspace checked out at exact target_sha.
 * Builder writable worktrees MUST NOT be reused.
 */
export function createReviewerWorkspace(
  args: CreateReviewerWorkspaceArgs,
): ReviewerWorkspace {
  const resolved = resolveExactCommitSha(args.repoPath, args.targetSha);

  const workspaceId = reviewerWorkspaceId(args);
  const workspacePath = join(args.workspacesRoot, workspaceId);
  mkdirSync(args.workspacesRoot, { recursive: true });
  git(["worktree", "add", "--detach", workspacePath, resolved], args.repoPath);

  const head = git(["rev-parse", "HEAD"], workspacePath).toLowerCase();
  if (head !== resolved) {
    throw new ControlError(
      "TARGET_SHA_MISMATCH",
      `reviewer workspace HEAD ${head} != target ${resolved}`,
    );
  }

  const porcelain = git(["status", "--porcelain"], workspacePath);
  if (porcelain.length > 0) {
    throw new ControlError(
      "WORKSPACE_DIRTY",
      `reviewer workspace dirty before review:\n${porcelain}`,
    );
  }

  const treeHashBefore = git(["rev-parse", "HEAD^{tree}"], workspacePath);
  return {
    workspacePath,
    workspaceId,
    targetSha: resolved,
    headAtCheckout: head,
    treeHashBefore,
  };
}

export interface ReviewerImmutabilityProof {
  head: string;
  treeHash: string;
  porcelain: string;
  headMatchesTarget: boolean;
  treeUnchanged: boolean;
  trackedClean: boolean;
  noNewCommit: boolean;
}

/**
 * Fail-closed immutability gate after Reviewer runtime returns.
 */
export function verifyReviewerWorkspaceImmutable(args: {
  workspacePath: string;
  targetSha: string;
  treeHashBefore: string;
}): ReviewerImmutabilityProof {
  const head = git(["rev-parse", "HEAD"], args.workspacePath);
  const treeHash = git(["rev-parse", "HEAD^{tree}"], args.workspacePath);
  const porcelain = git(["status", "--porcelain"], args.workspacePath);

  const headMatchesTarget = head === args.targetSha;
  const treeUnchanged = treeHash === args.treeHashBefore;
  const trackedClean = porcelain.length === 0;
  const noNewCommit = headMatchesTarget;

  if (!headMatchesTarget) {
    throw new ControlError(
      "SOURCE_MUTATION",
      `reviewer HEAD moved: ${head} != ${args.targetSha}`,
    );
  }
  if (!treeUnchanged) {
    throw new ControlError(
      "SOURCE_MUTATION",
      `reviewer tree changed: ${treeHash} != ${args.treeHashBefore}`,
    );
  }
  if (!trackedClean) {
    throw new ControlError(
      "WORKSPACE_DIRTY",
      `reviewer workspace dirty after review:\n${porcelain}`,
    );
  }

  return {
    head,
    treeHash,
    porcelain,
    headMatchesTarget,
    treeUnchanged,
    trackedClean,
    noNewCommit,
  };
}

export interface ReviewerWorkspaceCleanupProof {
  workspace_id: string;
  workspace_path: string;
  remove_attempted: boolean;
  registered_after_cleanup: boolean;
  path_exists_after_cleanup: boolean;
  workspace_removed: boolean;
}

function worktreeStillRegistered(repoPath: string, workspacePath: string): boolean {
  const list = git(["worktree", "list", "--porcelain"], repoPath);
  const normalized = workspacePath.replace(/\\/g, "/").toLowerCase();
  for (const line of list.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).replace(/\\/g, "/").toLowerCase();
    if (path === normalized) return true;
  }
  return false;
}

/**
 * Remove disposable Reviewer workspace and verify it is gone.
 * Fail closed: every failure in this boundary maps to
 * REVIEWER_WORKSPACE_CLEANUP_FAILED (never leaks WORKTREE_ERROR).
 */
export function removeReviewerWorkspace(args: {
  repoPath: string;
  workspacePath: string;
  workspaceId: string;
  /** Test seam for verification registration check. */
  verifyStillRegistered?: (
    repoPath: string,
    workspacePath: string,
  ) => boolean;
}): ReviewerWorkspaceCleanupProof {
  try {
    let removeAttempted = false;
    try {
      removeAttempted = true;
      git(["worktree", "remove", "--force", args.workspacePath], args.repoPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ControlError(
        "REVIEWER_WORKSPACE_CLEANUP_FAILED",
        `worktree remove failed: ${message}`,
      );
    }

    const checkRegistered =
      args.verifyStillRegistered ?? worktreeStillRegistered;
    let registered: boolean;
    try {
      registered = checkRegistered(args.repoPath, args.workspacePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ControlError(
        "REVIEWER_WORKSPACE_CLEANUP_FAILED",
        `worktree list verification failed: ${message}`,
      );
    }

    let pathExists: boolean;
    try {
      pathExists = existsSync(args.workspacePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ControlError(
        "REVIEWER_WORKSPACE_CLEANUP_FAILED",
        `filesystem verification failed: ${message}`,
      );
    }

    const proof: ReviewerWorkspaceCleanupProof = {
      workspace_id: args.workspaceId,
      workspace_path: args.workspacePath,
      remove_attempted: removeAttempted,
      registered_after_cleanup: registered,
      path_exists_after_cleanup: pathExists,
      workspace_removed: !registered && !pathExists,
    };

    if (!proof.workspace_removed) {
      throw new ControlError(
        "REVIEWER_WORKSPACE_CLEANUP_FAILED",
        `workspace still present after cleanup: registered=${registered} path_exists=${pathExists}`,
      );
    }
    return proof;
  } catch (err) {
    if (
      err instanceof ControlError &&
      err.code === "REVIEWER_WORKSPACE_CLEANUP_FAILED"
    ) {
      throw err;
    }
    throw new ControlError(
      "REVIEWER_WORKSPACE_CLEANUP_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  }
}
