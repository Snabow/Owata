export interface ProgramControlProbeResult {
  ok: boolean;
  authReady: boolean;
  runtimeVersion?: string;
  gitVersion?: string;
  detail?: string;
}

export interface ProgramControlAttemptSpec {
  /** Ephemeral working directory for the PC runtime (-C). Not a Reviewer worktree. */
  workDir: string;
  instructionPath: string;
  resultEnvelopePath: string;
  /** Directory that may receive writable artifacts (result envelope). */
  artifactsDir: string;
  signal?: AbortSignal;
}

export interface ProgramControlStartHandle {
  pid?: number;
  cancel(): void;
}

export interface ProgramControlWaitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Provider-neutral Program Control runtime binding.
 * Implementations MUST NOT reuse Builder or Reviewer session/trust domains.
 */
export interface ProgramControlBinding {
  readonly bindingId: string;
  readonly bindingVersion: string;
  probe(): Promise<ProgramControlProbeResult>;
  start(attempt: ProgramControlAttemptSpec): Promise<ProgramControlStartHandle>;
  wait(handle: ProgramControlStartHandle): Promise<ProgramControlWaitResult>;
  cancel(handle: ProgramControlStartHandle): Promise<void>;
}
