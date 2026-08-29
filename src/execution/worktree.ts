import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/types.js";

export interface CreateAttemptWorktreeArgs {
  repoPath: string;
  baseSha: string;
  worktreesRoot: string;
  cycleId: string;
  requestId: string;
  dispatchId: string;
  attemptNumber: number;
}

export interface AttemptWorktree {
  worktreePath: string;
  worktreeId: string;
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
    throw new ControlError("WORKTREE_ERROR", `git ${args.join(" ")} failed: ${message}`);
  }
}

export function attemptWorktreeId(args: {
  cycleId: string;
  requestId: string;
  dispatchId: string;
  attemptNumber: number;
}): string {
  return `${args.cycleId}__${args.requestId}__${args.dispatchId}__attempt-${args.attemptNumber}`;
}

export function createAttemptWorktree(
  args: CreateAttemptWorktreeArgs,
): AttemptWorktree {
  const worktreeId = attemptWorktreeId(args);
  const worktreePath = join(args.worktreesRoot, worktreeId);
  mkdirSync(args.worktreesRoot, { recursive: true });
  git(["rev-parse", "--verify", `${args.baseSha}^{commit}`], args.repoPath);
  git(
    ["worktree", "add", worktreePath, args.baseSha],
    args.repoPath,
  );
  return { worktreePath, worktreeId };
}

export function removeAttemptWorktree(args: {
  repoPath: string;
  worktreePath: string;
}): void {
  git(["worktree", "remove", "--force", args.worktreePath], args.repoPath);
}
