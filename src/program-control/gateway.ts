import { existsSync } from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/types.js";
import {
  defaultPreflight,
  type AdapterIdentity,
  type PreflightResult,
  type ProgramControlAdapter,
  type ProgramControlInput,
} from "../control/adapters.js";
import { type Capability } from "../control/protocol.js";
import type {
  ProgramControlBinding,
  ProgramControlProbeResult,
} from "./binding.js";
import { compileProgramControlInstruction } from "./prompt-compiler.js";
import { assertStrictProgramControlDecision } from "./strict-result.js";
import {
  ensureExecutionDir,
  readText,
  writeText,
} from "../execution/artifacts.js";
import { extractJsonObject } from "../reviewer/gateway.js";

const PC_CAPS: Capability[] = ["repository_read"];

export interface GatewayProgramControlAdapterOptions {
  binding: ProgramControlBinding;
  stateDir: string;
  clock?: { id(prefix?: string): string; now(): string };
  /**
   * When true, never fall back to any fake/scripted Program Control.
   * Real path is always fail-closed. Default true.
   */
  failClosedNoFakeFallback?: boolean;
}

/**
 * Provider-neutral real Program Control execution boundary.
 * NEVER silently falls back to FakeProgramControlAdapter.
 */
export class GatewayProgramControlAdapter implements ProgramControlAdapter {
  readonly identity: AdapterIdentity = {
    adapter_id: "gateway-program-control",
    role: "program_control",
  };

  private probeCache: ProgramControlProbeResult = {
    ok: false,
    authReady: false,
  };

  constructor(private readonly opts: GatewayProgramControlAdapterOptions) {
    if (opts.failClosedNoFakeFallback === false) {
      throw new ControlError(
        "PROTOCOL",
        "GatewayProgramControlAdapter must remain fail-closed (no fake fallback)",
      );
    }
  }

  capabilities(): Capability[] {
    return [...PC_CAPS];
  }

  async refreshProbe(): Promise<ProgramControlProbeResult> {
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

  get lastProbe(): ProgramControlProbeResult {
    return this.probeCache;
  }

  async decide(input: ProgramControlInput): Promise<unknown> {
    if (!input.dispatch) {
      throw new ControlError(
        "DISPATCH_REQUIRED",
        "Gateway Program Control requires dispatch lease context",
      );
    }
    if (!input.request) {
      throw new ControlError(
        "DISPATCH_REQUIRED",
        "Gateway Program Control requires current control_request",
      );
    }

    if (!this.probeCache.authReady) {
      throw new ControlError(
        "CREDENTIAL_UNAVAILABLE",
        "Program Control authReady=false; refusing runtime spawn",
      );
    }
    if (!this.probeCache.ok) {
      throw new ControlError(
        "AGENT_UNAVAILABLE",
        "Program Control runtime unavailable",
      );
    }

    const dispatch = input.dispatch;
    const artifacts = ensureExecutionDir(this.opts.stateDir, dispatch.dispatch_id);

    const compiled = compileProgramControlInstruction({
      request: input.request,
      cycle: input.cycle,
      envelopes: input.envelopes,
      resultEnvelopeRelPath: artifacts.resultEnvelopePath,
    });
    writeText(artifacts.instructionPath, compiled.text);
    writeText(
      join(artifacts.executionDir, "durable-envelopes.json"),
      JSON.stringify(input.envelopes, null, 2),
    );
    writeText(
      artifacts.metadataPath,
      JSON.stringify(
        {
          dispatch_id: dispatch.dispatch_id,
          attempt_number: dispatch.attempt_number,
          binding_id: this.opts.binding.bindingId,
          binding_version: this.opts.binding.bindingVersion,
          runtime_version: this.probeCache.runtimeVersion ?? null,
          prompt_hash: compiled.promptHash,
          template_version: compiled.templateVersion,
          auth_ready: this.probeCache.authReady,
          cycle_id: input.cycle.cycle_id,
          request_id: input.request.request_id,
        },
        null,
        2,
      ),
    );

    const handle = await this.opts.binding.start({
      workDir: artifacts.executionDir,
      instructionPath: artifacts.instructionPath,
      resultEnvelopePath: artifacts.resultEnvelopePath,
      artifactsDir: artifacts.executionDir,
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
      throw new ControlError("RESULT_STALE", "Program Control dispatch aborted");
    }

    let raw: unknown | null = null;
    const candidates: string[] = [];
    if (existsSync(artifacts.resultEnvelopePath)) {
      candidates.push(readText(artifacts.resultEnvelopePath));
    }
    const lastMsg = join(artifacts.executionDir, "codex-last-message.txt");
    if (existsSync(lastMsg)) {
      candidates.push(readText(lastMsg));
    }
    candidates.push(waitResult.stdout);
    let lastErr: unknown = null;
    for (const text of candidates) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      try {
        raw = extractJsonObject(trimmed);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (raw == null) {
      throw new ControlError(
        "RESULT_INVALID",
        `Program Control runtime did not produce parseable JSON${
          lastErr instanceof Error ? `: ${lastErr.message}` : ""
        }`,
      );
    }

    const parsed = assertStrictProgramControlDecision(raw);
    if (parsed.cycle_id !== input.cycle.cycle_id) {
      throw new ControlError(
        "RESULT_STALE",
        `cycle_id mismatch: ${parsed.cycle_id} != ${input.cycle.cycle_id}`,
      );
    }
    if (parsed.request_id !== input.request.request_id) {
      throw new ControlError(
        "RESULT_STALE",
        `request_id mismatch: ${parsed.request_id} != ${input.request.request_id}`,
      );
    }

    writeText(
      join(artifacts.executionDir, "program-control-result-accepted.json"),
      JSON.stringify(parsed, null, 2),
    );
    return parsed;
  }
}
