import { writeFileSync } from "node:fs";
import type {
  ProgramControlAttemptSpec,
  ProgramControlBinding,
  ProgramControlProbeResult,
  ProgramControlStartHandle,
  ProgramControlWaitResult,
} from "../binding.js";

/**
 * Deterministic in-process Program Control binding for tests.
 * Never falls back to FakeProgramControlAdapter.
 */
export class ScriptedProgramControlBinding implements ProgramControlBinding {
  readonly bindingId = "scripted-program-control";
  readonly bindingVersion = "test-1";

  probeResult: ProgramControlProbeResult = {
    ok: true,
    authReady: true,
    runtimeVersion: "scripted-pc-1",
    gitVersion: "git version test",
  };

  /** Called once per start; may write result file. */
  onStart: (attempt: ProgramControlAttemptSpec) => void = () => undefined;

  startCount = 0;

  async probe(): Promise<ProgramControlProbeResult> {
    return { ...this.probeResult };
  }

  async start(
    attempt: ProgramControlAttemptSpec,
  ): Promise<ProgramControlStartHandle> {
    this.startCount += 1;
    this.onStart(attempt);
    return {
      pid: 5151,
      cancel: () => undefined,
    };
  }

  async wait(_handle: ProgramControlStartHandle): Promise<ProgramControlWaitResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async cancel(handle: ProgramControlStartHandle): Promise<void> {
    handle.cancel();
  }

  writeResult(path: string, envelope: unknown): void {
    writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  }
}
