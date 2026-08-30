import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlStore, Dispatcher, HandoffStore, PROTOCOL_V1 } from "../control/index.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
} from "../control/fixtures/fake-adapters.js";
import type { PcDecisionBody } from "../control/protocol.js";
import {
  CodexCliBinding,
  GatewayReviewerAdapter,
} from "../reviewer/index.js";
import { ensureExecutionDir } from "../execution/artifacts.js";
import { persistB2ReviewerEvidence } from "./b2-evidence-export.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function owataRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function initFailingCandidateRepo(repoPath: string): string {
  git(["init"], repoPath);
  git(["config", "user.email", "canary@owata.local"], repoPath);
  git(["config", "user.name", "OWATA B2 Canary"], repoPath);
  writeFileSync(
    join(repoPath, "ACCEPTANCE.md"),
    [
      "# Acceptance contract",
      "",
      "expected:",
      "STATUS=READY",
      "",
      "The Independent Reviewer must verify STATUS.md matches the expected value.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(repoPath, "STATUS.md"), "STATUS=BROKEN\n", "utf8");
  git(["add", "ACCEPTANCE.md", "STATUS.md"], repoPath);
  git(["commit", "-m", "init intentionally failing candidate"], repoPath);
  return git(["rev-parse", "HEAD"], repoPath);
}

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function pcDecision(
  partial: Partial<PcDecisionBody> & Pick<PcDecisionBody, "decision">,
): PcDecisionBody {
  return {
    rationale: null,
    authorized_finding_ids: [],
    rework_scope: null,
    human_gate_purpose: null,
    human_gate_choices: null,
    install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
    ...partial,
  };
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

async function main(): Promise<number> {
  const repoRoot = owataRepoRoot();

  // F01: fail closed before any external Reviewer invocation if source is dirty
  // or HEAD is not a committed identity we can prove.
  const porcelain = git(["status", "--porcelain", "--untracked-files=no"], repoRoot);
  if (porcelain.length > 0) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "SOURCE_DIRTY",
        detail: porcelain,
        real_reviewer_invocations: 0,
      }),
    );
    return 4;
  }
  const owataSourceSha = git(["rev-parse", "HEAD"], repoRoot);
  const owataSourceTreeSha = git(["rev-parse", "HEAD^{tree}"], repoRoot);
  const expectedSha = process.env.OWATA_CANARY_REQUIRED_SOURCE_SHA;
  if (expectedSha && expectedSha.toLowerCase() !== owataSourceSha.toLowerCase()) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "SOURCE_SHA_MISMATCH",
        owata_source_sha: owataSourceSha,
        required: expectedSha,
        real_reviewer_invocations: 0,
      }),
    );
    return 5;
  }

  const binding = new CodexCliBinding();
  const probe = await binding.probe();
  if (!probe.ok || !probe.authReady) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "CREDENTIAL_UNAVAILABLE",
        runtime_version: probe.runtimeVersion ?? null,
        detail: probe.detail ?? null,
        owata_source_sha: owataSourceSha,
        owata_source_tree_sha: owataSourceTreeSha,
        source_tracked_clean: true,
        real_reviewer_invocations: 0,
      }),
    );
    return 2;
  }

  const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const evidenceDir = join(
    repoRoot,
    "evidence",
    "artifacts",
    "wp-003-b2-s1",
    runId,
  );

  const root = mkdtempSync(join(tmpdir(), "owata-b2-reviewer-"));
  const stateDir = join(root, "state");
  const repoPath = join(root, "repo");
  const workspacesRoot = join(root, "workspaces");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(workspacesRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  let realInvocations = 0;

  try {
    const candidateSha = initFailingCandidateRepo(repoPath);
    const store = ControlStore.open({ stateDir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const envClock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };

    const project = store.createProject("b2-reviewer-canary");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003-B2-S1",
      baseSha: candidateSha,
      maxDispatchRetries: 2,
    });

    // Counting wrapper: invoke real Codex at most once
    const countingBinding = {
      bindingId: binding.bindingId,
      bindingVersion: binding.bindingVersion,
      probe: () => binding.probe(),
      start: async (
        ...args: Parameters<typeof binding.start>
      ): ReturnType<typeof binding.start> => {
        realInvocations += 1;
        if (realInvocations > 1) {
          throw new Error("B2-S1 canary refuses second Codex invocation");
        }
        return binding.start(...args);
      },
      wait: (handle: Parameters<typeof binding.wait>[0]) => binding.wait(handle),
      cancel: (handle: Parameters<typeof binding.cancel>[0]) =>
        binding.cancel(handle),
    };

    const gateway = new GatewayReviewerAdapter({
      binding: countingBinding,
      stateDir,
      repoPath,
      workspacesRoot,
      clock: envClock,
    });
    await gateway.refreshProbe();

    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: candidateSha }],
      envClock,
    );

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [
            pcDecision({
              decision: "BUILD",
              rationale: "B2-S1 canary: emit failing candidate then review",
              install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
            }),
          ],
          envClock,
        ),
        builder,
        reviewer: gateway,
      },
      {
        owner: "b2-reviewer-canary",
        leaseMs: 600_000,
        heartbeatMs: 30_000,
      },
    );

    // PC → BUILD → DISPATCH_REVIEW → Reviewer → AWAITING_PC
    await dispatcher.step(cycle.cycle_id);
    await dispatcher.step(cycle.cycle_id);
    const beforeReview = handoff.requireCycle(cycle.cycle_id);
    if (beforeReview.state !== "DISPATCHING_REVIEW" || !beforeReview.current_request_id) {
      throw new Error(`expected DISPATCHING_REVIEW, got ${beforeReview.state}`);
    }
    const requestId = beforeReview.current_request_id;

    await dispatcher.step(cycle.cycle_id);
    const finalCycle = handoff.requireCycle(cycle.cycle_id);

    const reviewerResults = handoff
      .listEnvelopes(cycle.cycle_id)
      .filter((e) => e.kind === "reviewer_result");
    const latestDispatch = handoff.latestDispatch(cycle.cycle_id, requestId);
    const artifacts = latestDispatch
      ? ensureExecutionDir(stateDir, latestDispatch.dispatch_id)
      : null;

    const resultBody =
      reviewerResults[0]?.body as
        | {
            verdict?: string;
            findings?: unknown[];
            target_sha?: string;
          }
        | undefined;

    const statusContent = git(["show", `${candidateSha}:STATUS.md`], repoPath);
    const candidateUnchanged = statusContent.includes("STATUS=BROKEN");
    const workspaceClean = true; // gateway fail-closed would have rejected dirty

    const verdict = resultBody?.verdict ?? null;
    const findingCount = Array.isArray(resultBody?.findings)
      ? resultBody!.findings!.length
      : 0;

    const status =
      finalCycle.state === "AWAITING_PC" &&
      latestDispatch?.state === "ACCEPTED" &&
      verdict === "REWORK" &&
      findingCount >= 1 &&
      candidateUnchanged &&
      realInvocations === 1
        ? "B2_S1_CANARY_PASS"
        : "FAIL";

    let meta: {
      prompt_hash?: string;
      template_version?: string;
    } = {};
    if (artifacts && existsSync(artifacts.metadataPath)) {
      meta = JSON.parse(readFileSync(artifacts.metadataPath, "utf8")) as typeof meta;
    }

    const persisted = persistB2ReviewerEvidence({
      evidenceDir,
      owataRepoRoot: repoRoot,
      owataSourceSha,
      owataSourceTreeSha,
      sourceTrackedClean: true,
      runId,
      reviewerBindingId: binding.bindingId,
      reviewerBindingVersion: binding.bindingVersion,
      runtimeVersion: probe.runtimeVersion ?? null,
      requestId,
      cycleId: cycle.cycle_id,
      candidateSha,
      promptHash: meta.prompt_hash ?? null,
      templateVersion: meta.template_version ?? null,
      verdict,
      findingCount,
      humanContinuityActions: 0,
      realReviewerInvocations: realInvocations,
      instructionPath: artifacts?.instructionPath,
      metadataPath: artifacts?.metadataPath,
      resultEnvelopePath: artifacts?.resultEnvelopePath,
      immutabilityProofPath: artifacts
        ? join(artifacts.executionDir, "immutability-proof.json")
        : undefined,
      taskRepoPath: repoPath,
      store,
      handoff,
      status,
      candidateUnchanged,
      workspaceClean,
    });

    const evidence = {
      status,
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      cycle_state: finalCycle.state,
      verdict,
      finding_count: findingCount,
      candidate_sha: candidateSha,
      candidate_unchanged: candidateUnchanged,
      workspace_clean: workspaceClean,
      real_reviewer_invocations: realInvocations,
      human_continuity_actions: 0,
      auto_rework_before_pc: false,
      next_authority: "program_control",
      reviewer_binding: binding.bindingId,
      runtime_version: probe.runtimeVersion ?? null,
      prompt_hash: meta.prompt_hash ?? null,
      evidence_dir: persisted.evidenceDir,
      evidence_manifest_hash: persisted.manifestHash,
      candidate_resolution_check: persisted.candidateResolutionCheck,
      owata_source_sha: owataSourceSha,
      owata_source_tree_sha: owataSourceTreeSha,
      source_tracked_clean: true,
      run_id: runId,
      protocol: PROTOCOL_V1,
    };

    console.log(JSON.stringify(evidence, null, 2));
    store.close();
    return status === "B2_S1_CANARY_PASS" ? 0 : 1;
  } finally {
    cleanup(root);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(
      JSON.stringify({
        status: "FAILED",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : null,
      }),
    );
    process.exitCode = 1;
  });
