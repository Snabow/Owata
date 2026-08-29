import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { HandoffStore } from "../control/handoff.js";
import type { ControlStore } from "../control/store.js";
import { hashFile } from "../execution/artifacts.js";

export interface CanaryEvidenceAttempt {
  dispatch_id: string;
  attempt_number: number;
  fence_token: string;
  state: string;
  pid?: number | null;
  killed?: boolean;
  prompt_hash?: string | null;
  instruction_path?: string;
  metadata_path?: string;
  result_envelope_path?: string;
  worktree_rel?: string | null;
}

export interface PersistCanaryEvidenceArgs {
  /** Destination under the OWATA candidate repo, e.g. evidence/artifacts/wp-003-slice-2/<run-id> */
  evidenceDir: string;
  owataRepoRoot: string;
  owataSourceSha: string;
  runId: string;
  cursorCliVersion: string | null;
  modelId: string;
  requestId: string;
  cycleId: string;
  attempt1: CanaryEvidenceAttempt;
  attempt2: CanaryEvidenceAttempt;
  candidateSha: string | null;
  taskRepoPath: string;
  stateDir: string;
  store: ControlStore;
  handoff: HandoffStore;
  humanContinuityActions: number;
  resumeFlagsUsed: boolean;
  continueFlagsUsed: boolean;
  status: string;
}

export interface PersistCanaryEvidenceResult {
  evidenceDir: string;
  manifestPath: string;
  manifestHash: string;
  artifactHashes: Record<string, string>;
  candidateResolutionCheck: "PASS" | "FAIL" | "SKIPPED";
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeCopyText(src: string | undefined, dest: string): boolean {
  if (!src || !existsSync(src)) return false;
  copyFileSync(src, dest);
  return true;
}

/**
 * Persist an independently inspectable B1 evidence bundle, then verify the
 * task-repo git bundle can resolve the candidate SHA. Does not copy raw
 * runtime-output or credentials.
 */
export function persistCanaryEvidence(
  args: PersistCanaryEvidenceArgs,
): PersistCanaryEvidenceResult {
  mkdirSync(args.evidenceDir, { recursive: true });
  const artifactHashes: Record<string, string> = {};

  const record = (rel: string, abs: string) => {
    artifactHashes[rel] = hashFile(abs);
  };

  // Durable state export (text/JSON preferred).
  const cycle = args.handoff.requireCycle(args.cycleId);
  const dispatches = args.store.db
    .prepare(`SELECT * FROM dispatches WHERE cycle_id = ? ORDER BY attempt_number`)
    .all(args.cycleId);
  const envelopes = args.handoff.listEnvelopes(args.cycleId);
  const humanGates = args.store.db
    .prepare(`SELECT * FROM human_gates WHERE cycle_id = ?`)
    .all(args.cycleId);
  const events = args.store
    .listEvents()
    .filter((e) => {
      const payload = e.payload as { cycle_id?: string } | null;
      return (
        e.project_id === cycle.project_id ||
        payload?.cycle_id === args.cycleId
      );
    });

  const stateExport = {
    cycle,
    dispatches,
    envelopes,
    human_gates: humanGates,
    human_gates_count: humanGates.length,
    events,
  };
  const statePath = join(args.evidenceDir, "durable-state.json");
  writeJson(statePath, stateExport);
  record("durable-state.json", statePath);

  // Builder instructions / metadata / accepted result (no runtime-output).
  for (const [label, attempt] of [
    ["attempt1", args.attempt1],
    ["attempt2", args.attempt2],
  ] as const) {
    const instrDest = join(args.evidenceDir, `${label}-instruction.txt`);
    if (safeCopyText(attempt.instruction_path, instrDest)) {
      record(`${label}-instruction.txt`, instrDest);
    }
    const metaDest = join(args.evidenceDir, `${label}-metadata.json`);
    if (safeCopyText(attempt.metadata_path, metaDest)) {
      record(`${label}-metadata.json`, metaDest);
    }
    if (attempt.result_envelope_path && existsSync(attempt.result_envelope_path)) {
      const envDest = join(args.evidenceDir, `${label}-result-envelope.json`);
      copyFileSync(attempt.result_envelope_path, envDest);
      record(`${label}-result-envelope.json`, envDest);
    }
  }

  // Task repo as inspectable git bundle.
  let candidateResolutionCheck: PersistCanaryEvidenceResult["candidateResolutionCheck"] =
    "SKIPPED";
  const bundlePath = join(args.evidenceDir, "task-repo.bundle");
  git(["bundle", "create", bundlePath, "--all"], args.taskRepoPath);
  record("task-repo.bundle", bundlePath);

  if (args.candidateSha) {
    const verifyRoot = mkdtempSync(join(tmpdir(), "owata-bundle-verify-"));
    try {
      git(["clone", bundlePath, verifyRoot], tmpdir());
      const resolved = git(["rev-parse", args.candidateSha], verifyRoot);
      if (resolved !== args.candidateSha) {
        throw new Error(
          `bundle candidate resolve mismatch: ${resolved} != ${args.candidateSha}`,
        );
      }
      git(["show", `${args.candidateSha}:README.md`], verifyRoot);
      candidateResolutionCheck = "PASS";
    } catch (err) {
      candidateResolutionCheck = "FAIL";
      throw err;
    } finally {
      try {
        rmSync(verifyRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  const invocationFlags = {
    explicit_model: true,
    model_id: args.modelId,
    resume_flag_used: args.resumeFlagsUsed,
    continue_flag_used: args.continueFlagsUsed,
    auto_router_used: false,
  };
  const flagsPath = join(args.evidenceDir, "invocation-flags.json");
  writeJson(flagsPath, invocationFlags);
  record("invocation-flags.json", flagsPath);

  const manifest = {
    run_id: args.runId,
    status: args.status,
    owata_source_sha: args.owataSourceSha,
    cursor_cli_version: args.cursorCliVersion,
    model_id: args.modelId,
    request_id: args.requestId,
    cycle_id: args.cycleId,
    attempt1: {
      dispatch_id: args.attempt1.dispatch_id,
      attempt_number: args.attempt1.attempt_number,
      fence_token: args.attempt1.fence_token,
      state: args.attempt1.state,
      pid: args.attempt1.pid ?? null,
      killed: args.attempt1.killed ?? false,
      prompt_hash: args.attempt1.prompt_hash ?? null,
    },
    attempt2: {
      dispatch_id: args.attempt2.dispatch_id,
      attempt_number: args.attempt2.attempt_number,
      fence_token: args.attempt2.fence_token,
      state: args.attempt2.state,
      prompt_hash: args.attempt2.prompt_hash ?? null,
      fence_differs_from_attempt1:
        args.attempt2.fence_token !== args.attempt1.fence_token,
    },
    candidate_sha: args.candidateSha,
    human_continuity_actions: args.humanContinuityActions,
    resume_flags_used: args.resumeFlagsUsed,
    continue_flags_used: args.continueFlagsUsed,
    candidate_resolution_check: candidateResolutionCheck,
    artifact_hashes: artifactHashes,
    evidence_rel:
      relative(args.owataRepoRoot, args.evidenceDir).replace(/\\/g, "/") ||
      args.evidenceDir,
  };

  const manifestPath = join(args.evidenceDir, "manifest.json");
  writeJson(manifestPath, manifest);
  const manifestHash = hashFile(manifestPath);
  // Re-write with self hash for convenience (hash of content without this field).
  const manifestWithHash = { ...manifest, manifest_content_sha256: manifestHash };
  writeJson(manifestPath, manifestWithHash);

  return {
    evidenceDir: args.evidenceDir,
    manifestPath,
    manifestHash: sha256Text(JSON.stringify(manifest)),
    artifactHashes: {
      ...artifactHashes,
      "manifest.json": hashFile(manifestPath),
    },
    candidateResolutionCheck,
  };
}
