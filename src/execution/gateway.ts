import { existsSync } from "node:fs";
import { ControlError } from "../control/types.js";
import {
  defaultPreflight,
  type AdapterIdentity,
  type BuilderAdapter,
  type BuilderInput,
  type PreflightResult,
} from "../control/adapters.js";
import {
  PROTOCOL_V1,
  type Capability,
  type ControlRequestBody,
} from "../control/protocol.js";
import type { ExecutionBinding, ExecutionProbeResult } from "./binding.js";
import {
  ensureExecutionDir,
  readText,
  writeText,
} from "./artifacts.js";
import { compileBuilderInstruction } from "./prompt-compiler.js";
import { createAttemptWorktree, removeAttemptWorktree } from "./worktree.js";
import { assertNonClaudeModel } from "./model-policy.js";
import { CursorCliBinding } from "./bindings/cursor-cli.js";

const GATEWAY_CAPS: Capability[] = [
  "repository_read",
  "repository_write",
  "exact_checkout",
  "command_execution",
];

export interface GatewayBuilderAdapterOptions {
  binding: ExecutionBinding;
  stateDir: string;
  repoPath: string;
  worktreesRoot: string;
  modelId?: string;
  clock?: { id(prefix?: string): string; now(): string };
}

export class GatewayBuilderAdapter implements BuilderAdapter {
  readonly identity: AdapterIdentity = {
    adapter_id: "gateway-builder",
    role: "builder",
  };

  private probeCache: ExecutionProbeResult = { ok: false, authReady: false };

  constructor(private readonly opts: GatewayBuilderAdapterOptions) {}

  capabilities(): Capability[] {
    return [...GATEWAY_CAPS];
  }

  async refreshProbe(): Promise<ExecutionProbeResult> {
    this.probeCache = await this.opts.binding.probe();
    return this.probeCache;
  }

  preflight(required: Capability[]): PreflightResult {
    const base = defaultPreflight(this.capabilities(), required);
    if (!base.ok) return base;
    if (!this.probeCache.ok || !this.probeCache.authReady) {
      return { ok: false, missing: ["command_execution"] };
    }
    return { ok: true, missing: [] };
  }

  private async resolveModelId(): Promise<string> {
    if (this.opts.modelId) {
      assertNonClaudeModel(this.opts.modelId);
      return this.opts.modelId;
    }
    if (this.opts.binding instanceof CursorCliBinding) {
      return this.opts.binding.discoverNonClaudeModel();
    }
    throw new ControlError(
      "MODEL_REQUIRED",
      "Gateway builder requires modelId or CursorCliBinding",
    );
  }

  async build(input: BuilderInput): Promise<unknown> {
    if (!input.dispatch) {
      throw new ControlError(
        "DISPATCH_REQUIRED",
        "Gateway builder requires dispatch lease context",
      );
    }

    const baseSha = input.request.body.base_sha ?? input.cycle.base_sha;
    if (!baseSha) {
      throw new ControlError(
        "BASE_SHA_REQUIRED",
        "Builder request requires resolvable base_sha",
      );
    }

    const dispatch = input.dispatch;
    const artifacts = ensureExecutionDir(this.opts.stateDir, dispatch.dispatch_id);
    const modelId = await this.resolveModelId();

    const worktree = createAttemptWorktree({
      repoPath: this.opts.repoPath,
      baseSha,
      worktreesRoot: this.opts.worktreesRoot,
      cycleId: input.cycle.cycle_id,
      requestId: input.request.request_id!,
      dispatchId: dispatch.dispatch_id,
      attemptNumber: dispatch.attempt_number,
    });

    try {
      const compiled = compileBuilderInstruction({
        request: input.request,
        cycle: input.cycle,
        resultEnvelopeRelPath: artifacts.resultEnvelopePath,
        envelopes: input.envelopes ?? [],
      });
      writeText(artifacts.instructionPath, compiled.text);
      writeText(
        artifacts.metadataPath,
        JSON.stringify(
          {
            dispatch_id: dispatch.dispatch_id,
            attempt_number: dispatch.attempt_number,
            model_id: modelId,
            prompt_hash: compiled.promptHash,
            template_version: compiled.templateVersion,
            worktree_path: worktree.worktreePath,
          },
          null,
          2,
        ),
      );

      const handle = await this.opts.binding.start({
        worktreePath: worktree.worktreePath,
        instructionPath: artifacts.instructionPath,
        resultEnvelopePath: artifacts.resultEnvelopePath,
        modelId,
        signal: input.signal,
      });

      const onAbort = () => {
        void this.opts.binding.cancel(handle);
      };
      input.signal?.addEventListener("abort", onAbort);

      let waitResult;
      try {
        waitResult = await this.opts.binding.wait(handle);
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }

      writeText(
        artifacts.runtimeOutputPath,
        [
          `exit_code=${waitResult.exitCode ?? "null"}`,
          "--- stdout ---",
          waitResult.stdout,
          "--- stderr ---",
          waitResult.stderr,
        ].join("\n"),
      );

      if (input.signal?.aborted) {
        throw new ControlError("RESULT_STALE", "Builder dispatch aborted");
      }

      if (existsSync(artifacts.resultEnvelopePath)) {
        return JSON.parse(readText(artifacts.resultEnvelopePath)) as unknown;
      }

      const trimmed = waitResult.stdout.trim();
      if (trimmed.startsWith("{")) {
        return JSON.parse(trimmed) as unknown;
      }

      throw new ControlError(
        "RESULT_INVALID",
        "Builder runtime did not produce result-envelope.json or parseable stdout JSON",
      );
    } catch (err) {
      try {
        removeAttemptWorktree({
          repoPath: this.opts.repoPath,
          worktreePath: worktree.worktreePath,
        });
      } catch {
        // Best-effort cleanup after failed attempts.
      }
      throw err;
    }
  }

  /** Wrap raw runtime envelope with canonical metadata when needed. */
  normalizeEnvelope(
    raw: unknown,
    input: BuilderInput,
  ): Record<string, unknown> {
    if (
      raw != null &&
      typeof raw === "object" &&
      "kind" in raw &&
      (raw as { kind: string }).kind === "builder_result"
    ) {
      return raw as Record<string, unknown>;
    }
    const clock = this.opts.clock;
    return {
      protocol: PROTOCOL_V1,
      envelope_id: clock?.id("env") ?? `env_${Date.now()}`,
      kind: "builder_result",
      cycle_id: input.cycle.cycle_id,
      request_id: input.request.request_id,
      from_role: "builder",
      to_role: "program_control",
      created_at: clock?.now() ?? new Date().toISOString(),
      body: raw,
    };
  }
}
