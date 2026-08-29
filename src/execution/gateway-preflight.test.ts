import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControlError,
  ControlStore,
  Dispatcher,
  HandoffStore,
} from "../control/index.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "../control/fixtures/fake-adapters.js";
import type { BuilderInput } from "../control/adapters.js";
import type { PcDecisionBody } from "../control/protocol.js";
import {
  GatewayBuilderAdapter,
  type ExecutionBinding,
  type ExecutionProbeResult,
} from "../execution/index.js";

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-auth-pre-"));
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

class StubBinding implements ExecutionBinding {
  readonly bindingId = "stub";
  readonly bindingVersion = "test";
  probeResult: ExecutionProbeResult = {
    ok: true,
    authReady: false,
    agentVersion: "test",
    gitVersion: "test",
  };
  startCalls = 0;

  async probe(): Promise<ExecutionProbeResult> {
    return this.probeResult;
  }

  async start(): Promise<{ pid: number; cancel(): void }> {
    this.startCalls += 1;
    throw new Error("start must not be called");
  }

  async wait(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return { exitCode: 1, stdout: "", stderr: "" };
  }

  async cancel(): Promise<void> {
    return;
  }
}

test("gateway preflight fails when ok=true but authReady=false", async () => {
  const dir = tempState();
  try {
    const binding = new StubBinding();
    binding.probeResult = {
      ok: true,
      authReady: false,
      agentVersion: "x",
      gitVersion: "y",
    };
    const gateway = new GatewayBuilderAdapter({
      binding,
      stateDir: dir,
      repoPath: dir,
      worktreesRoot: join(dir, "wt"),
      modelId: "composer-2.5",
    });
    await gateway.refreshProbe();
    const pre = gateway.preflight([
      "repository_read",
      "repository_write",
      "exact_checkout",
      "command_execution",
    ]);
    assert.equal(pre.ok, false);
    assert.ok(pre.missing.includes("command_execution"));
  } finally {
    cleanup(dir);
  }
});

test("gateway preflight passes when ok and authReady", async () => {
  const dir = tempState();
  try {
    const binding = new StubBinding();
    binding.probeResult = {
      ok: true,
      authReady: true,
      agentVersion: "x",
      gitVersion: "y",
    };
    const gateway = new GatewayBuilderAdapter({
      binding,
      stateDir: dir,
      repoPath: dir,
      worktreesRoot: join(dir, "wt"),
      modelId: "composer-2.5",
    });
    await gateway.refreshProbe();
    const pre = gateway.preflight([
      "repository_read",
      "repository_write",
      "exact_checkout",
      "command_execution",
    ]);
    assert.equal(pre.ok, true);
  } finally {
    cleanup(dir);
  }
});

test("auth regression does not call binding.start via dispatcher capability block", async () => {
  const dir = tempState();
  try {
    const binding = new StubBinding();
    binding.probeResult = {
      ok: true,
      authReady: false,
      agentVersion: "x",
      gitVersion: "y",
    };
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };
    const gateway = new GatewayBuilderAdapter({
      binding,
      stateDir: dir,
      repoPath: dir,
      worktreesRoot: join(dir, "wt"),
      modelId: "composer-2.5",
      clock,
    });
    await gateway.refreshProbe();

    const project = store.createProject("auth-block");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base",
    });
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD" })],
          clock,
        ),
        builder: gateway,
        reviewer: new FakeReviewerAdapter([], clock),
      },
      { owner: "test", leaseMs: 60_000, gitReality: async () => undefined },
    );
    await dispatcher.step(cycle.cycle_id);
    const result = await dispatcher.step(cycle.cycle_id);
    assert.equal(result.action, "capability_block");
    assert.equal(binding.startCalls, 0);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("heartbeat abort classifies as RESULT_STALE not RUNTIME_ERROR", async () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const clock = {
      id: (prefix?: string) => store.nextId(prefix),
      now: () => store.now().toISOString(),
    };

    class SlowBuilder extends FakeBuilderAdapter {
      override async build(input: BuilderInput): Promise<unknown> {
        await new Promise<void>((resolve, reject) => {
          if (input.signal?.aborted) {
            reject(
              input.signal.reason instanceof Error
                ? input.signal.reason
                : new ControlError("RESULT_STALE", "aborted"),
            );
            return;
          }
          input.signal?.addEventListener("abort", () => {
            reject(
              input.signal?.reason instanceof Error
                ? input.signal.reason
                : new ControlError("RESULT_STALE", "aborted"),
            );
          });
        });
        return super.build(input);
      }
    }

    const builder = new SlowBuilder(
      [{ status: "CANDIDATE_READY", candidate_sha: "x" }],
      clock,
    );
    // Keep fake-builder id so missing gitReality is irrelevant; we never accept.
    const project = store.createProject("hb-stale");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-003",
      baseSha: "base",
    });
    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: new FakeProgramControlAdapter(
          [pcDecision({ decision: "BUILD" })],
          clock,
        ),
        builder,
        reviewer: new FakeReviewerAdapter([], clock),
      },
      { owner: "test", leaseMs: 50, heartbeatMs: 20 },
    );
    await dispatcher.step(cycle.cycle_id);

    // Force lease into non-renewable state shortly after claim inside step.
    const stepPromise = dispatcher.step(cycle.cycle_id);
    await new Promise((r) => setTimeout(r, 30));
    const live = handoff.requireCycle(cycle.cycle_id);
    const requestId = live.current_request_id!;
    const dispatch = handoff.latestDispatch(cycle.cycle_id, requestId)!;
    store.db
      .prepare(`UPDATE dispatches SET state = 'RECOVERED' WHERE dispatch_id = ?`)
      .run(dispatch.dispatch_id);

    const result = await stepPromise;
    assert.equal(result.action, "result_stale");
    store.close();
  } finally {
    cleanup(dir);
  }
});
