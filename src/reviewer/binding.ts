export interface ReviewerProbeResult {
  ok: boolean;
  authReady: boolean;
  runtimeVersion?: string;
  gitVersion?: string;
  detail?: string;
}

export interface ReviewerAttemptSpec {
  worktreePath: string;
  instructionPath: string;
  resultEnvelopePath: string;
  /** Directory that may receive writable artifacts (result envelope). */
  artifactsDir: string;
  signal?: AbortSignal;
}

export interface ReviewerStartHandle {
  pid?: number;
  cancel(): void;
}

export interface ReviewerWaitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Provider-neutral Independent Reviewer runtime binding.
 * Implementations MUST NOT reuse Builder session/trust domain.
 */
export interface ReviewerBinding {
  readonly bindingId: string;
  readonly bindingVersion: string;
  probe(): Promise<ReviewerProbeResult>;
  start(attempt: ReviewerAttemptSpec): Promise<ReviewerStartHandle>;
  wait(handle: ReviewerStartHandle): Promise<ReviewerWaitResult>;
  cancel(handle: ReviewerStartHandle): Promise<void>;
}
