import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore, Dispatcher, HandoffStore, PROTOCOL_V1 } from "../control/index.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
} from "../control/fixtures/fake-adapters.js";
import type { PcDecisionBody } from "../control/protocol.js";
import { GatewayReviewerAdapter } from "./gateway.js";
import { ScriptedReviewerBinding } from "./fixtures/scripted-binding.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
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

test("Reviewer REWORK returns to Program Control; no automatic Builder REWORK", async () => {
  const root = mkdtempSync(join(tmpdir(), "owata-rev-pc2-"));
  try {
    const repoPath = join(root, "repo");
    mkdirSync(repoPath, { recursive: true });
    git(["init"], repoPath);
    git(["config", "user.email", "test@owata.local"], repoPath);
    git(["config", "user.name", "OWATA Test"], repoPath);
    writeFileSync(join(repoPath, "STATUS.md"), "STATUS=BROKEN\n", "utf8");
    git(["add", "."], repoPath);
    git(["commit", "-m", "broken"], repoPath);
    const candidateSha = git(["rev-parse", "HEAD"], repoPath);

    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const store = ControlStore.open({ stateDir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };

    const project = store.createProject("b2-rework-pc2");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003-B2-S1",
      baseSha: candidateSha,
      maxDispatchRetries: 4,
    });

    let reviewRequestId: string | null = null;
    const binding = new ScriptedReviewerBinding();
    binding.onStart = (attempt) => {
      binding.writeResult(attempt.resultEnvelopePath, {
        protocol: PROTOCOL_V1,
        envelope_id: "env_rev_rework",
        kind: "reviewer_result",
        cycle_id: cycle.cycle_id,
        request_id: reviewRequestId,
        from_role: "reviewer",
        to_role: "program_control",
        created_at: new Date().toISOString(),
        body: {
          target_sha: candidateSha,
          verdict: "REWORK",
          findings: [
            {
              finding_id: "F_STATUS",
              severity: "high",
              summary: "STATUS.md is BROKEN; expected READY",
            },
          ],
          evidence_refs: [],
        },
      });
    };

    const gateway = new GatewayReviewerAdapter({
      binding,
      stateDir,
      repoPath,
      workspacesRoot: join(root, "ws"),
      clock,
    });
    await gateway.refreshProbe();

    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: candidateSha }],
      clock,
    );

    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          rationale: "produce candidate",
          install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
        }),
      ],
      clock,
    );

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder,
        reviewer: gateway,
      },
      {
        owner: "b2-test",
        leaseMs: 60_000,
        heartbeatMs: 0,
      },
    );

    await dispatcher.step(cycle.cycle_id);
    assert.equal(handoff.requireCycle(cycle.cycle_id).state, "DISPATCHING_BUILD");

    await dispatcher.step(cycle.cycle_id);
    const afterBuild = handoff.requireCycle(cycle.cycle_id);
    assert.equal(afterBuild.state, "DISPATCHING_REVIEW");
    assert.ok(afterBuild.current_request_id);
    reviewRequestId = afterBuild.current_request_id;

    const builderInvocationsBeforeReview = builder.invocations;

    await dispatcher.step(cycle.cycle_id);
    const afterReview = handoff.requireCycle(cycle.cycle_id);
    assert.equal(afterReview.state, "AWAITING_PC");
    assert.equal(afterReview.current_request_id, null);
    assert.equal(binding.startCount, 1);
    assert.equal(builder.invocations, builderInvocationsBeforeReview);
    assert.equal(pc.invocations, 1);

    const reviewerResults = handoff
      .listEnvelopes(cycle.cycle_id)
      .filter((e) => e.kind === "reviewer_result");
    assert.equal(reviewerResults.length, 1);
    const body = reviewerResults[0].body as {
      verdict: string;
      findings: unknown[];
    };
    assert.equal(body.verdict, "REWORK");
    assert.equal(body.findings.length, 1);

    store.close();
  } finally {
    cleanup(root);
  }
});
