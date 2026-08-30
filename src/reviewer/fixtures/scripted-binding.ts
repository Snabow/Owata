import type {
  ReviewerAttemptSpec,
  ReviewerBinding,
  ReviewerProbeResult,
  ReviewerStartHandle,
  ReviewerWaitResult,
} from "../binding.js";
import { writeFileSync } from "node:fs";

/**
 * Deterministic in-process Reviewer binding for tests.
 * Never falls back to FakeReviewerAdapter; scripts return envelopes or mutate workspace.
 */
export class ScriptedReviewerBinding implements ReviewerBinding {
  readonly bindingId = "scripted-reviewer";
  readonly bindingVersion = "test-1";

  probeResult: ReviewerProbeResult = {
    ok: true,
    authReady: true,
    runtimeVersion: "scripted-1",
    gitVersion: "git version test",
  };

  /** Called once per start; may write result file and/or mutate workspace. */
  onStart: (attempt: ReviewerAttemptSpec) => void = () => undefined;

  startCount = 0;
  private lastHandle: ReviewerStartHandle | null = null;

  async probe(): Promise<ReviewerProbeResult> {
    return { ...this.probeResult };
  }

  async start(attempt: ReviewerAttemptSpec): Promise<ReviewerStartHandle> {
    this.startCount += 1;
    this.onStart(attempt);
    const handle: ReviewerStartHandle = {
      pid: 4242,
      cancel: () => undefined,
    };
    this.lastHandle = handle;
    return handle;
  }

  async wait(_handle: ReviewerStartHandle): Promise<ReviewerWaitResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async cancel(handle: ReviewerStartHandle): Promise<void> {
    handle.cancel();
  }

  writeResult(path: string, envelope: unknown): void {
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  }
}
