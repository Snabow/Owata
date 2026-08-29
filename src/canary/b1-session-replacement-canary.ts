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
import { join } from "node:path";
import { ControlStore, Dispatcher, HandoffStore, PROTOCOL_V1 } from "../control/index.js";
import {
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "../control/fixtures/fake-adapters.js";
import type { PcDecisionBody } from "../control/protocol.js";
import {
  CursorCliBinding,
  GatewayBuilderAdapter,
  assertNonClaudeModel,
  compileBuilderInstruction,
  createAttemptWorktree,
  ensureExecutionDir,
  removeAttemptWorktree,
  verifyCandidateGitReality,
  writeText,
} from "../execution/index.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initTaskRepo(repoPath: string): string {
  git(["init"], repoPath);
  git(["config", "user.email", "canary@owata.local"], repoPath);
  git(["config", "user.name", "OWATA Canary"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "TODO: set STATUS=READY\n", "utf8");
  writeFileSync(
    join(repoPath, "CANARY_TASK.md"),
    [
      "# Canary task",
      "",
      "1. Edit README.md so it contains exactly one content line: STATUS=READY",
      "2. git add README.md",
      "3. git commit -m \"canary: set STATUS=READY\"",
      "4. Write the canonical builder_result envelope JSON to the path named in the builder instruction (result_envelope_path).",
      "5. Set body.candidate_sha to the commit SHA from git rev-parse HEAD.",
      "",
    ].join("\n"),
    "utf8",
  );
  git(["add", "README.md", "CANARY_TASK.md"], repoPath);
  git(["commit", "-m", "init"], repoPath);
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
    install_policy: { on_builder_candidate: "AWAIT_PC" },
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
  const binding = new CursorCliBinding();
  const probe = await binding.probe();
  if (!probe.ok || !probe.authReady) {
    console.log(
      JSON.stringify({
        status: "BLOCKED",
        reason: "CREDENTIAL_UNAVAILABLE",
        cursor_cli_version: probe.agentVersion ?? null,
        detail: probe.detail ?? null,
      }),
    );
    return 2;
  }

  let modelId: string;
  try {
    const discovered = await binding.discoverNonClaudeModel();
    const catalog = await binding.listNonClaudeModels();
    // Sol can be listed while the account is spend-limited for API models.
    // Prefer an explicit Composer id when Sol is the catalog preference.
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
      }),
    );
    return 3;
  }

  const root = mkdtempSync(join(tmpdir(), "owata-b1-canary-"));
  const stateDir = join(root, "state");
  const repoPath = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  try {
    const baseSha = initTaskRepo(repoPath);
    const store = ControlStore.open({ stateDir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const envClock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };

    const project = store.createProject("b1-canary");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003-B1",
      baseSha,
      maxDispatchRetries: 4,
    });

    const gateway = new GatewayBuilderAdapter({
      binding,
      stateDir,
      repoPath,
      worktreesRoot,
      modelId,
      clock: envClock,
    });
    await gateway.refreshProbe();

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD", rationale: "canary build" })],
          envClock,
        ),
        builder: gateway,
        reviewer: new FakeReviewerAdapter([], envClock),
      },
      {
        owner: "b1-canary",
        leaseMs: 180_000,
        heartbeatMs: 20_000,
        gitReality: async (ctx) => {
          const artifacts = ensureExecutionDir(
            stateDir,
            ctx.dispatch.dispatch_id,
          );
          const meta = JSON.parse(
            readFileSync(artifacts.metadataPath, "utf8"),
          ) as { worktree_path: string };
          verifyCandidateGitReality({
            repoPath,
            worktreePath: meta.worktree_path,
            baseSha: ctx.request.body.base_sha ?? ctx.cycle.base_sha,
            candidateSha: ctx.candidate_sha,
          });
        },
      },
    );

    // PC → DISPATCHING_BUILD
    await dispatcher.step(cycle.cycle_id);
    const afterPc = handoff.requireCycle(cycle.cycle_id);
    if (afterPc.state !== "DISPATCHING_BUILD" || !afterPc.current_request_id) {
      throw new Error(`expected DISPATCHING_BUILD, got ${afterPc.state}`);
    }
    const requestId = afterPc.current_request_id;
    const request = handoff
      .listEnvelopes(cycle.cycle_id)
      .find((e) => e.request_id === requestId)!;

    // --- Attempt 1: claim, spawn real Cursor CLI, kill before accept ---
    const attempt1 = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId,
      targetRole: "builder",
      owner: "b1-canary",
      leaseMs: 180_000,
    });
    const artifacts1 = ensureExecutionDir(stateDir, attempt1.dispatch_id);
    const wt1 = createAttemptWorktree({
      repoPath,
      baseSha,
      worktreesRoot,
      cycleId: cycle.cycle_id,
      requestId,
      dispatchId: attempt1.dispatch_id,
      attemptNumber: attempt1.attempt_number,
    });
    const compiled1 = compileBuilderInstruction({
      request: request as never,
      cycle: handoff.snapshot(afterPc),
      resultEnvelopeRelPath: artifacts1.resultEnvelopePath,
    });
    writeText(artifacts1.instructionPath, compiled1.text);
    writeText(
      artifacts1.metadataPath,
      JSON.stringify(
        {
          dispatch_id: attempt1.dispatch_id,
          attempt_number: attempt1.attempt_number,
          model_id: modelId,
          prompt_hash: compiled1.promptHash,
          worktree_path: wt1.worktreePath,
          phase: "attempt1_kill",
        },
        null,
        2,
      ),
    );

    const handle1 = await binding.start({
      worktreePath: wt1.worktreePath,
      instructionPath: artifacts1.instructionPath,
      resultEnvelopePath: artifacts1.resultEnvelopePath,
      modelId,
    });
    const pid1 = handle1.pid ?? null;
    if (pid1 == null) {
      throw new Error("attempt1 Cursor CLI did not expose a pid");
    }
    // Prove runtime started, then kill (no --resume/--continue ever used).
    await new Promise((r) => setTimeout(r, 1500));
    await binding.cancel(handle1);
    try {
      await binding.wait(handle1);
    } catch {
      // killed process may reject wait
    }

    // Expire attempt-1 lease and recover.
    store.db
      .prepare(`UPDATE dispatches SET lease_expires_at = ? WHERE dispatch_id = ?`)
      .run(
        new Date(store.now().getTime() - 1).toISOString(),
        attempt1.dispatch_id,
      );
    handoff.recoverExpiredDispatches(store.now());
    const expired = handoff.getDispatch(attempt1.dispatch_id)!;
    if (expired.state !== "EXPIRED") {
      throw new Error(`expected EXPIRED attempt1, got ${expired.state}`);
    }

    // Stale attempt-1 synthetic result must not accept under a later fence.
    // Claim attempt 2 first so attempt1 fence is non-current, then prove reject.
    // --- Attempt 2: fresh process + fresh worktree via Dispatcher/Gateway ---
    const resumed = await dispatcher.runUntilStable(cycle.cycle_id, 12);
    const finalCycle = handoff.requireCycle(cycle.cycle_id);
    const latest = handoff.latestDispatch(cycle.cycle_id, requestId)!;

    let staleRejected = false;
    try {
      handoff.acceptResult({
        dispatchId: attempt1.dispatch_id,
        fenceToken: attempt1.fence_token,
        envelope: {
          protocol: PROTOCOL_V1,
          envelope_id: "env_stale_attempt1",
          kind: "builder_result",
          cycle_id: cycle.cycle_id,
          request_id: requestId,
          from_role: "builder",
          to_role: "program_control",
          created_at: new Date().toISOString(),
          body: {
            status: "CANDIDATE_READY",
            candidate_sha: baseSha,
            evidence_refs: [],
            notes: "late attempt1",
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      staleRejected = /stale|fence|not current|already/i.test(msg);
    }

    const readme =
      finalCycle.latest_candidate_sha != null
        ? git(
            ["show", `${finalCycle.latest_candidate_sha}:README.md`],
            repoPath,
          )
        : existsSync(join(repoPath, "README.md"))
          ? readFileSync(join(repoPath, "README.md"), "utf8")
          : "";

    const evidence = {
      status:
        latest.state === "ACCEPTED" &&
        latest.attempt_number >= 2 &&
        staleRejected &&
        readme.includes("STATUS=READY")
          ? "B1_CANARY_CANDIDATE"
          : "FAIL",
      cycle_id: cycle.cycle_id,
      request_id: requestId,
      attempt1_dispatch_id: attempt1.dispatch_id,
      attempt1_pid: pid1,
      attempt1_killed: true,
      attempt1_state: expired.state,
      attempt2_dispatch_id: latest.dispatch_id,
      attempt2_attempt_number: latest.attempt_number,
      attempt2_fence_differs: latest.fence_token !== attempt1.fence_token,
      worktree1: wt1.worktreePath,
      stale_attempt_rejected: staleRejected,
      candidate_sha: finalCycle.latest_candidate_sha,
      readme_excerpt: readme.slice(0, 160),
      model_id: modelId,
      model_explicit: true,
      claude_used: false,
      auto_router_used: false,
      resume_flags_used: false,
      resumed_action: resumed.action,
      prompt_hash_attempt1: compiled1.promptHash,
      human_continuity_actions: 0,
    };

    console.log(JSON.stringify(evidence, null, 2));

    // Cleanup worktrees best-effort
    try {
      removeAttemptWorktree({
        repoPath,
        worktreePath: wt1.worktreePath,
      });
    } catch {
      // ignore
    }

    return evidence.status === "B1_CANARY_CANDIDATE" ? 0 : 1;
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
