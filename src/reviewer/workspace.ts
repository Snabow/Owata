import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/types.js";

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
  let resolved: string;
  try {
    resolved = git(
      ["rev-parse", "--verify", `${args.targetSha}^{commit}`],
      args.repoPath,
    );
  } catch {
    throw new ControlError(
      "TARGET_SHA_UNRESOLVED",
      `target_sha unresolved: ${args.targetSha}`,
    );
  }

  const workspaceId = reviewerWorkspaceId(args);
  const workspacePath = join(args.workspacesRoot, workspaceId);
  mkdirSync(args.workspacesRoot, { recursive: true });
  git(["worktree", "add", "--detach", workspacePath, resolved], args.repoPath);

  const head = git(["rev-parse", "HEAD"], workspacePath);
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

export function removeReviewerWorkspace(args: {
  repoPath: string;
  workspacePath: string;
}): void {
  git(["worktree", "remove", "--force", args.workspacePath], args.repoPath);
}
