import { execFileSync } from "node:child_process";

export interface VerifyCandidateGitRealityArgs {
  repoPath: string;
  worktreePath: string;
  baseSha: string | null;
  candidateSha: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(args: string[], cwd: string): boolean {
  try {
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function verifyCandidateGitReality(
  args: VerifyCandidateGitRealityArgs,
): void {
  let resolvedCandidate: string;
  try {
    resolvedCandidate = git(
      ["rev-parse", "--verify", `${args.candidateSha}^{commit}`],
      args.repoPath,
    );
  } catch {
    throw new Error(
      `Git reality check failed: candidate_sha "${args.candidateSha}" does not resolve`,
    );
  }

  if (args.baseSha != null) {
    let resolvedBase: string;
    try {
      resolvedBase = git(
        ["rev-parse", "--verify", `${args.baseSha}^{commit}`],
        args.repoPath,
      );
    } catch {
      throw new Error(
        `Git reality check failed: base_sha "${args.baseSha}" does not resolve`,
      );
    }
    if (
      !gitOk(
        ["merge-base", "--is-ancestor", resolvedBase, resolvedCandidate],
        args.repoPath,
      )
    ) {
      throw new Error(
        `Git reality check failed: base_sha ${resolvedBase} is not an ancestor of candidate ${resolvedCandidate}`,
      );
    }
  }

  const worktreeHead = git(["rev-parse", "HEAD"], args.worktreePath);
  if (worktreeHead !== resolvedCandidate) {
    throw new Error(
      `Git reality check failed: worktree HEAD ${worktreeHead} != candidate ${resolvedCandidate}`,
    );
  }

  const porcelain = git(["status", "--porcelain"], args.worktreePath);
  if (porcelain.length > 0) {
    throw new Error(
      `Git reality check failed: worktree has porcelain changes:\n${porcelain}`,
    );
  }
}
