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

export interface PersistB2ReviewerEvidenceArgs {
  evidenceDir: string;
  owataRepoRoot: string;
  owataSourceSha: string;
  owataSourceTreeSha?: string;
  sourceTrackedClean?: boolean;
  runId: string;
  reviewerBindingId: string;
  reviewerBindingVersion: string;
  runtimeVersion: string | null;
  requestId: string;
  cycleId: string;
  candidateSha: string;
  promptHash: string | null;
  templateVersion: string | null;
  verdict: string | null;
  findingCount: number;
  humanContinuityActions: number;
  realReviewerInvocations: number;
  instructionPath?: string;
  metadataPath?: string;
  resultEnvelopePath?: string;
  immutabilityProofPath?: string;
  workspaceCleanupProofPath?: string;
  workspaceRemoved?: boolean;
  taskRepoPath: string;
  store: ControlStore;
  handoff: HandoffStore;
  status: string;
  candidateUnchanged: boolean;
  workspaceClean: boolean;
}

export interface PersistB2ReviewerEvidenceResult {
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
 * Persist B2-S1 real Reviewer canary evidence (no credentials / raw unbounded stdout).
 */
export function persistB2ReviewerEvidence(
  args: PersistB2ReviewerEvidenceArgs,
): PersistB2ReviewerEvidenceResult {
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

  const reviewRequest = envelopes.find(
    (e) => e.kind === "control_request" && e.request_id === args.requestId,
  );
  if (reviewRequest) {
    const reqPath = join(args.evidenceDir, "canonical-review-request.json");
    writeJson(reqPath, reviewRequest);
    record("canonical-review-request.json", reqPath);
  }

  if (safeCopyText(args.instructionPath, join(args.evidenceDir, "reviewer-instruction.txt"))) {
    record("reviewer-instruction.txt", join(args.evidenceDir, "reviewer-instruction.txt"));
  }
  if (safeCopyText(args.metadataPath, join(args.evidenceDir, "reviewer-metadata.json"))) {
    record("reviewer-metadata.json", join(args.evidenceDir, "reviewer-metadata.json"));
  }
  if (
    args.resultEnvelopePath &&
    existsSync(args.resultEnvelopePath)
  ) {
    const dest = join(args.evidenceDir, "reviewer-result-envelope.json");
    copyFileSync(args.resultEnvelopePath, dest);
    record("reviewer-result-envelope.json", dest);

    try {
      const parsed = JSON.parse(readFileSync(dest, "utf8")) as {
        body?: { findings?: unknown[] };
      };
      const findings = parsed.body?.findings ?? [];
      const findingsPath = join(args.evidenceDir, "findings.json");
      writeJson(findingsPath, findings);
      record("findings.json", findingsPath);
    } catch {
      // schema already validated upstream for accepted runs
    }
  }

  if (
    safeCopyText(
      args.immutabilityProofPath,
      join(args.evidenceDir, "immutability-proof.json"),
    )
  ) {
    record(
      "immutability-proof.json",
      join(args.evidenceDir, "immutability-proof.json"),
    );
  }

  if (
    safeCopyText(
      args.workspaceCleanupProofPath,
      join(args.evidenceDir, "workspace-cleanup-proof.json"),
    )
  ) {
    record(
      "workspace-cleanup-proof.json",
      join(args.evidenceDir, "workspace-cleanup-proof.json"),
    );
  }

  const candidateProof = {
    candidate_sha: args.candidateSha,
    candidate_unchanged: args.candidateUnchanged,
    workspace_clean: args.workspaceClean,
  };
  const proofPath = join(args.evidenceDir, "candidate-resolution-proof.json");
  writeJson(proofPath, candidateProof);
  record("candidate-resolution-proof.json", proofPath);

  let candidateResolutionCheck: PersistB2ReviewerEvidenceResult["candidateResolutionCheck"] =
    "SKIPPED";
  const bundlePath = join(args.evidenceDir, "task-repo.bundle");
  git(["bundle", "create", bundlePath, "--all"], args.taskRepoPath);
  record("task-repo.bundle", bundlePath);

  const verifyRoot = mkdtempSync(join(tmpdir(), "owata-b2-bundle-"));
  try {
    git(["clone", bundlePath, verifyRoot], tmpdir());
    const resolved = git(["rev-parse", args.candidateSha], verifyRoot);
    if (resolved !== args.candidateSha) {
      throw new Error(
        `bundle candidate resolve mismatch: ${resolved} != ${args.candidateSha}`,
      );
    }
    git(["show", `${args.candidateSha}:STATUS.md`], verifyRoot);
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
    owata_source_sha: args.owataSourceSha,
    owata_source_tree_sha: args.owataSourceTreeSha ?? null,
    source_tracked_clean: args.sourceTrackedClean ?? null,
    candidate_sha: args.candidateSha,
    request_id: args.requestId,
    cycle_id: args.cycleId,
    reviewer_binding: args.reviewerBindingId,
    reviewer_binding_version: args.reviewerBindingVersion,
    runtime_version: args.runtimeVersion,
    prompt_hash: args.promptHash,
    template_version: args.templateVersion,
    verdict: args.verdict,
    finding_count: args.findingCount,
    human_continuity_actions: args.humanContinuityActions,
    real_reviewer_invocations: args.realReviewerInvocations,
    candidate_unchanged: args.candidateUnchanged,
    workspace_clean: args.workspaceClean,
    workspace_removed: args.workspaceRemoved === true,
    candidate_resolution_check: candidateResolutionCheck,
    artifact_hashes: artifactHashes,
    evidence_rel:
      relative(args.owataRepoRoot, args.evidenceDir).replace(/\\/g, "/") ||
      args.evidenceDir,
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
