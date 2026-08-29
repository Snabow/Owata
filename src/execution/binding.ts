export interface ExecutionProbeResult {
  ok: boolean;
  authReady: boolean;
  agentVersion?: string;
  gitVersion?: string;
  detail?: string;
}

export interface ExecutionAttemptSpec {
  worktreePath: string;
  instructionPath: string;
  resultEnvelopePath: string;
  modelId: string;
  signal?: AbortSignal;
}

export interface ExecutionStartHandle {
  pid?: number;
  cancel(): void;
}

export interface ExecutionWaitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecutionBinding {
  readonly bindingId: string;
  readonly bindingVersion: string;
  probe(): Promise<ExecutionProbeResult>;
  start(attempt: ExecutionAttemptSpec): Promise<ExecutionStartHandle>;
  wait(handle: ExecutionStartHandle): Promise<ExecutionWaitResult>;
  cancel(handle: ExecutionStartHandle): Promise<void>;
}
