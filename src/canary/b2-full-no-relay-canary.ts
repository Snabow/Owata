import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlStore, Dispatcher, HandoffStore, PROTOCOL_V1 } from "../control/index.js";
import type { PcDecisionBody, ReviewerResultBody } from "../control/protocol.js";
import {
  CodexCliProgramControlBinding,
  GatewayProgramControlAdapter,
} from "../program-control/index.js";
import {
  CursorCliBinding,
  GatewayBuilderAdapter,
  assertNonClaudeModel,
  ensureExecutionDir,
  verifyCandidateGitReality,
} from "../execution/index.js";
import {
  CodexCliBinding,
  GatewayReviewerAdapter,
} from "../reviewer/index.js";
import { persistB2FullEvidence } from "./b2-full-evidence-export.js";
import { B2FullCanaryInvocationBudget } from "./b2-full-invocation-budget.js";
import { ControlError } from "../control/types.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function owataRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Disposable task repo:
 * - ACCEPTANCE requires STATUS=READY
 * - BUILD_STAGE.md requires first BUILD to produce STATUS=BROKEN
 * - CANARY_TASK.md drives the Builder (existing instruction compiler hook)
 */
function initFullCycleTaskRepo(repoPath: string): string {
  git(["init"], repoPath);
  git(["config", "user.email", "canary@owata.local"], repoPath);
  git(["config", "user.name", "OWATA B2-S2 Canary"], repoPath);
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
  writeFileSync(
    join(repoPath, "BUILD_STAGE.md"),
    [
      "# Build stage contract (durable)",
      "",
      "1. First BUILD MUST produce STATUS.md containing exactly: STATUS=BROKEN",
      "2. Subsequent REWORK MUST produce STATUS.md containing exactly: STATUS=READY",
      "3. Do not skip the intentional BROKEN first candidate.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(repoPath, "CANARY_TASK.md"),
    [
      "# Canary task",
      "",
      "Follow BUILD_STAGE.md and ACCEPTANCE.md exactly.",
      "",
      "On BUILD (first attempt / no authorized findings):",
      "1. Write STATUS.md with exactly one content line: STATUS=BROKEN",
      "2. git add STATUS.md ACCEPTANCE.md BUILD_STAGE.md CANARY_TASK.md (as needed)",
      "3. git commit -m \"canary: first candidate STATUS=BROKEN\"",
      "4. Write the canonical builder_result envelope JSON to the path named in the builder instruction.",
      "5. Set body.candidate_sha to git rev-parse HEAD.",
      "",
      "On REWORK (authorized findings present):",
      "1. Write STATUS.md with exactly one content line: STATUS=READY",
      "2. git add STATUS.md",
      "3. git commit -m \"canary: rework STATUS=READY\"",
      "4. Write the canonical builder_result envelope JSON to the path named in the builder instruction.",
      "5. Set body.candidate_sha to git rev-parse HEAD.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(repoPath, "STATUS.md"), "STATUS=TODO\n", "utf8");
  git(
    ["add", "ACCEPTANCE.md", "BUILD_STAGE.md", "CANARY_TASK.md", "STATUS.md"],
    repoPath,
  );
  git(["commit", "-m", "init B2-S2 full no-relay canary task"], repoPath);
  return git(["rev-parse", "HEAD"], repoPath);
}

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function listExecutionArtifacts(
  stateDir: string,
): Array<{
  instructionPath?: string;
  metadataPath?: string;
  resultEnvelopePath?: string;
}> {
  const execRoot = join(stateDir, "execution");
  if (!existsSync(execRoot)) return [];
  const out: Array<{
    instructionPath?: string;
    metadataPath?: string;
    resultEnvelopePath?: string;
  }> = [];
  for (const name of readdirSync(execRoot)) {
    const paths = ensureExecutionDir(stateDir, name);
    out.push({
      instructionPath: existsSync(paths.instructionPath)
        ? paths.instructionPath
        : undefined,
      metadataPath: existsSync(paths.metadataPath)
        ? paths.metadataPath
        : undefined,
      resultEnvelopePath: existsSync(paths.resultEnvelopePath)
        ? paths.resultEnvelopePath
        : undefined,
    });
  }
  return out;
}

async function main(): Promise<number> {
  const repoRoot = owataRepoRoot();

  // Source provenance gates (same family as B2-S1)
  const porcelain = git(["status", "--porcelain", "--untracked-files=no"], repoRoot);
  if (porcelain.length > 0) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "SOURCE_DIRTY",
        detail: porcelain,
        browser_relay_used: false,
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
        browser_relay_used: false,
      }),
    );
    return 5;
  }

  const pcBinding = new CodexCliProgramControlBinding();
  const builderBinding = new CursorCliBinding();
  const reviewerBinding = new CodexCliBinding();

  const pcProbe = await pcBinding.probe();
  if (!pcProbe.ok || !pcProbe.authReady) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "CREDENTIAL_UNAVAILABLE",
        role: "program_control",
        runtime_version: pcProbe.runtimeVersion ?? null,
        detail: pcProbe.detail ?? null,
        owata_source_sha: owataSourceSha,
        browser_relay_used: false,
      }),
    );
    return 2;
  }

  const builderProbe = await builderBinding.probe();
  if (!builderProbe.ok || !builderProbe.authReady) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "CREDENTIAL_UNAVAILABLE",
        role: "builder",
        detail: builderProbe.detail ?? null,
        owata_source_sha: owataSourceSha,
        browser_relay_used: false,
      }),
    );
    return 2;
  }

  const reviewerProbe = await reviewerBinding.probe();
  if (!reviewerProbe.ok || !reviewerProbe.authReady) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "CREDENTIAL_UNAVAILABLE",
        role: "reviewer",
        detail: reviewerProbe.detail ?? null,
        owata_source_sha: owataSourceSha,
        browser_relay_used: false,
      }),
    );
    return 2;
  }

  let modelId: string;
  try {
    const discovered = await builderBinding.discoverNonClaudeModel();
    const catalog = await builderBinding.listNonClaudeModels();
    if (
      /gpt-5\.6.*sol/i.test(discovered) &&
      catalog.includes("composer-2.5")
    ) {
      modelId = "composer-2.5";
    } else if (
      /gpt-5\.6.*sol/i.test(discovered) &&
      catalog.includes("composer-2.5-fast")
    ) {
      modelId = "composer-2.5-fast";
    } else {
      modelId = discovered;
    }
    assertNonClaudeModel(modelId);
  } catch (err) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "NON_CLAUDE_BINDING_UNAVAILABLE",
        message: err instanceof Error ? err.message : String(err),
        browser_relay_used: false,
      }),
    );
    return 3;
  }

  const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const evidenceDir = join(
    repoRoot,
    "evidence",
    "artifacts",
    "wp-003-b2-s2",
    runId,
  );

  const root = mkdtempSync(join(tmpdir(), "owata-b2-full-"));
  const stateDir = join(root, "state");
  const repoPath = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  const workspacesRoot = join(root, "workspaces");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(workspacesRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    const baseSha = initFullCycleTaskRepo(repoPath);
    const store = ControlStore.open({ stateDir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const envClock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };

    const project = store.createProject("b2-full-no-relay-canary");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003-B2-S2",
      baseSha,
      maxDispatchRetries: 4,
    });

    const pcGateway = new GatewayProgramControlAdapter({
      binding: pcBinding,
      stateDir,
      clock: envClock,
    });
    await pcGateway.refreshProbe();

    const builderGateway = new GatewayBuilderAdapter({
      binding: builderBinding,
      stateDir,
      repoPath,
      worktreesRoot,
      modelId,
      clock: envClock,
    });
    await builderGateway.refreshProbe();

    const reviewerGateway = new GatewayReviewerAdapter({
      binding: reviewerBinding,
      stateDir,
      repoPath,
      workspacesRoot,
      clock: envClock,
    });
    await reviewerGateway.refreshProbe();

    // F03: hard pre-spawn budgets (canary-only)
    const budget = new B2FullCanaryInvocationBudget();
    const pcDecide = pcGateway.decide.bind(pcGateway);
    pcGateway.decide = async (input) => {
      budget.consume("program_control");
      return pcDecide(input);
    };
    const builderBuild = builderGateway.build.bind(builderGateway);
    builderGateway.build = async (input) => {
      budget.consume("builder");
      return builderBuild(input);
    };
    const reviewerReview = reviewerGateway.review.bind(reviewerGateway);
    reviewerGateway.review = async (input) => {
      budget.consume("reviewer");
      return reviewerReview(input);
    };

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pcGateway,
        builder: builderGateway,
        reviewer: reviewerGateway,
      },
      {
        owner: "b2-full-no-relay-canary",
        leaseMs: 600_000,
        heartbeatMs: 30_000,
        gitReality: async (ctx) => {
          const artifacts = ensureExecutionDir(
            stateDir,
            ctx.dispatch.dispatch_id,
          );
          const meta = JSON.parse(
            readFileSync(artifacts.metadataPath, "utf8"),
          ) as { worktree_path: string };
          // REWORK candidates must descend from the reviewed target_sha.
          const ancestryBase =
            ctx.request.body.action === "REWORK"
              ? ctx.request.body.target_sha
              : (ctx.request.body.base_sha ?? ctx.cycle.base_sha);
          verifyCandidateGitReality({
            repoPath,
            worktreePath: meta.worktree_path,
            baseSha: ancestryBase,
            candidateSha: ctx.candidate_sha,
          });
        },
      },
    );

    // Drive full cycle without Browser Relay
    let final;
    let budgetExceeded = false;
    let budgetDetail: string | null = null;
    try {
      final = await dispatcher.runUntilStable(cycle.cycle_id, 48);
    } catch (err) {
      if (
        err instanceof ControlError &&
        err.code === "CANARY_INVOCATION_BUDGET_EXCEEDED"
      ) {
        budgetExceeded = true;
        budgetDetail = err.message;
        final = {
          cycle: handoff.requireCycle(cycle.cycle_id),
          steps: [],
        };
      } else {
        throw err;
      }
    }

    const envelopes = handoff.listEnvelopes(cycle.cycle_id);
    const pcDecisions = envelopes
      .filter((e) => e.kind === "program_control_decision")
      .map((e) => (e.body as PcDecisionBody).decision);
    const reviewerVerdicts = envelopes
      .filter((e) => e.kind === "reviewer_result")
      .map((e) => (e.body as ReviewerResultBody).verdict);
    const candidateShas = envelopes
      .filter((e) => e.kind === "builder_result")
      .map((e) => {
        const body = e.body as { candidate_sha?: string | null };
        return body.candidate_sha;
      })
      .filter((s): s is string => typeof s === "string" && s.length > 0);

    const candidatesDiffer =
      candidateShas.length >= 2 &&
      new Set(candidateShas).size === candidateShas.length;

    const status = budgetExceeded
      ? "CANARY_INVOCATION_BUDGET_EXCEEDED"
      : final.cycle.state === "ACCEPTED" &&
          pcDecisions.length === 3 &&
          pcDecisions[0] === "BUILD" &&
          pcDecisions[1] === "REWORK" &&
          pcDecisions[2] === "ACCEPT" &&
          reviewerVerdicts.length === 2 &&
          reviewerVerdicts[0] === "REWORK" &&
          reviewerVerdicts[1] === "PASS" &&
          candidateShas.length === 2 &&
          candidatesDiffer &&
          final.cycle.accepted_candidate_sha === candidateShas[1]
        ? "B2_S2_CANARY_PASS"
        : "FAIL";

    const persisted = persistB2FullEvidence({
      evidenceDir,
      owataRepoRoot: repoRoot,
      owataSourceSha,
      owataSourceTreeSha,
      sourceTrackedClean: true,
      runId,
      cycleId: cycle.cycle_id,
      baseSha,
      candidateShas,
      acceptedCandidateSha: final.cycle.accepted_candidate_sha,
      pcDecisions,
      reviewerVerdicts,
      builderInvocations: budget.snapshot().builder,
      reviewerInvocations: budget.snapshot().reviewer,
      pcInvocations: budget.snapshot().program_control,
      humanContinuityActions: 0,
      browserRelayUsed: false,
      pcBindingId: pcBinding.bindingId,
      pcBindingVersion: pcBinding.bindingVersion,
      builderBindingId: builderBinding.bindingId,
      reviewerBindingId: reviewerBinding.bindingId,
      pcRuntimeVersion: pcProbe.runtimeVersion ?? null,
      builderRuntimeVersion: builderProbe.agentVersion ?? null,
      reviewerRuntimeVersion: reviewerProbe.runtimeVersion ?? null,
      taskRepoPath: repoPath,
      store,
      handoff,
      status,
      artifactPaths: listExecutionArtifacts(stateDir),
    });

    const evidence = {
      status,
      cycle_id: cycle.cycle_id,
      cycle_state: final.cycle.state,
      pc_decisions: pcDecisions,
      reviewer_verdicts: reviewerVerdicts,
      candidate_shas: candidateShas,
      accepted_candidate_sha: final.cycle.accepted_candidate_sha,
      candidates_differ: candidatesDiffer,
      human_continuity_actions: 0,
      browser_relay_used: false,
      invocation_budget: budget.snapshot(),
      budget_exceeded: budgetExceeded,
      budget_detail: budgetDetail,
      prior_diagnostic_run:
        "evidence/artifacts/wp-003-b2-s2/run_2026-08-30T01-44-57-755Z",
      pc_binding: pcBinding.bindingId,
      builder_binding: builderBinding.bindingId,
      reviewer_binding: reviewerBinding.bindingId,
      model_id: modelId,
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
    return status === "B2_S2_CANARY_PASS" ? 0 : 1;
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
        browser_relay_used: false,
      }),
    );
    process.exitCode = 1;
  });
