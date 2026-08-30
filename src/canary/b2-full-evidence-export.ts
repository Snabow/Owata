import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { HandoffStore } from "../control/handoff.js";
import type { ControlStore } from "../control/store.js";
import { hashFile } from "../execution/artifacts.js";

export interface PersistB2FullEvidenceArgs {
  evidenceDir: string;
  owataRepoRoot: string;
  owataSourceSha: string;
  owataSourceTreeSha?: string;
  sourceTrackedClean?: boolean;
  runId: string;
  cycleId: string;
  baseSha: string;
  candidateShas: string[];
  acceptedCandidateSha: string | null;
  pcDecisions: string[];
  reviewerVerdicts: string[];
  builderInvocations: number;
  reviewerInvocations: number;
  pcInvocations: number;
  humanContinuityActions: number;
  browserRelayUsed: boolean;
  pcBindingId: string;
  pcBindingVersion: string;
  builderBindingId: string;
  reviewerBindingId: string;
  pcRuntimeVersion: string | null;
  builderRuntimeVersion: string | null;
  reviewerRuntimeVersion: string | null;
  taskRepoPath: string;
  store: ControlStore;
  handoff: HandoffStore;
  status: string;
  artifactPaths?: {
    instructionPath?: string;
    metadataPath?: string;
    resultEnvelopePath?: string;
  }[];
  extraManifest?: Record<string, unknown>;
}

export interface PersistB2FullEvidenceResult {
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
 * Persist B2-S2 full no-relay canary evidence (no credentials / raw unbounded stdout).
 */
export function persistB2FullEvidence(
  args: PersistB2FullEvidenceArgs,
): PersistB2FullEvidenceResult {
  mkdirSync(args.evidenceDir, { recursive: true });
  const artifactHashes: Record<string, string> = {};

  const record = (rel: string, abs: string) => {
    artifactHashes[rel] = hashFile(abs);
  };

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

  const statePath = join(args.evidenceDir, "durable-state.json");
  writeJson(statePath, {
    cycle,
    dispatches,
    envelopes,
    human_gates: humanGates,
    human_gates_count: humanGates.length,
    events,
  });
  record("durable-state.json", statePath);

  const summaryPath = join(args.evidenceDir, "cycle-summary.json");
  writeJson(summaryPath, {
    pc_decisions: args.pcDecisions,
    reviewer_verdicts: args.reviewerVerdicts,
    candidate_shas: args.candidateShas,
    accepted_candidate_sha: args.acceptedCandidateSha,
    builder_invocations: args.builderInvocations,
    reviewer_invocations: args.reviewerInvocations,
    pc_invocations: args.pcInvocations,
    browser_relay_used: args.browserRelayUsed,
    human_continuity_actions: args.humanContinuityActions,
  });
  record("cycle-summary.json", summaryPath);

  let idx = 0;
  for (const paths of args.artifactPaths ?? []) {
    idx += 1;
    const prefix = `attempt-${idx}`;
    if (
      safeCopyText(
        paths.instructionPath,
        join(args.evidenceDir, `${prefix}-instruction.txt`),
      )
    ) {
      record(
        `${prefix}-instruction.txt`,
        join(args.evidenceDir, `${prefix}-instruction.txt`),
      );
    }
    if (
      safeCopyText(
        paths.metadataPath,
        join(args.evidenceDir, `${prefix}-metadata.json`),
      )
    ) {
      record(
        `${prefix}-metadata.json`,
        join(args.evidenceDir, `${prefix}-metadata.json`),
      );
    }
    if (
      safeCopyText(
        paths.resultEnvelopePath,
        join(args.evidenceDir, `${prefix}-result-envelope.json`),
      )
    ) {
      record(
        `${prefix}-result-envelope.json`,
        join(args.evidenceDir, `${prefix}-result-envelope.json`),
      );
    }
  }

  let candidateResolutionCheck: PersistB2FullEvidenceResult["candidateResolutionCheck"] =
    "SKIPPED";
  const bundlePath = join(args.evidenceDir, "task-repo.bundle");
  git(["bundle", "create", bundlePath, "--all"], args.taskRepoPath);
  record("task-repo.bundle", bundlePath);

  const verifyRoot = mkdtempSync(join(tmpdir(), "owata-b2s2-bundle-"));
  try {
    git(["clone", bundlePath, verifyRoot], tmpdir());
    for (const sha of args.candidateShas) {
      const resolved = git(["rev-parse", sha], verifyRoot);
      if (resolved !== sha) {
        throw new Error(`bundle candidate resolve mismatch: ${resolved} != ${sha}`);
      }
    }
    if (args.acceptedCandidateSha) {
      git(["show", `${args.acceptedCandidateSha}:STATUS.md`], verifyRoot);
    }
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

  const manifest = {
    run_id: args.runId,
    status: args.status,
    slice: "B2-S2_REAL_PROGRAM_CONTROL_FULL_NO_RELAY",
    owata_source_sha: args.owataSourceSha,
    owata_source_tree_sha: args.owataSourceTreeSha ?? null,
    source_tracked_clean: args.sourceTrackedClean ?? null,
    cycle_id: args.cycleId,
    base_sha: args.baseSha,
    candidate_shas: args.candidateShas,
    accepted_candidate_sha: args.acceptedCandidateSha,
    pc_decisions: args.pcDecisions,
    reviewer_verdicts: args.reviewerVerdicts,
    builder_invocations: args.builderInvocations,
    reviewer_invocations: args.reviewerInvocations,
    pc_invocations: args.pcInvocations,
    human_continuity_actions: args.humanContinuityActions,
    browser_relay_used: args.browserRelayUsed,
    pc_binding: args.pcBindingId,
    pc_binding_version: args.pcBindingVersion,
    builder_binding: args.builderBindingId,
    reviewer_binding: args.reviewerBindingId,
    pc_runtime_version: args.pcRuntimeVersion,
    builder_runtime_version: args.builderRuntimeVersion,
    reviewer_runtime_version: args.reviewerRuntimeVersion,
    candidate_resolution_check: candidateResolutionCheck,
    artifact_hashes: artifactHashes,
    evidence_rel:
      relative(args.owataRepoRoot, args.evidenceDir).replace(/\\/g, "/") ||
      args.evidenceDir,
    ...(args.extraManifest ?? {}),
  };

  const manifestPath = join(args.evidenceDir, "manifest.json");
  writeJson(manifestPath, manifest);
  const manifestHash = hashFile(manifestPath);
  writeJson(manifestPath, { ...manifest, manifest_content_sha256: manifestHash });

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
