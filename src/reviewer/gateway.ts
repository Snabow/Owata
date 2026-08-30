import { existsSync } from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/types.js";
import {
  defaultPreflight,
  type AdapterIdentity,
  type PreflightResult,
  type ReviewerAdapter,
  type ReviewerInput,
} from "../control/adapters.js";
import {
  PROTOCOL_V1,
  parseCanonicalEnvelope,
  type Capability,
  type ReviewerResultBody,
} from "../control/protocol.js";
import type { ReviewerBinding, ReviewerProbeResult } from "./binding.js";
import { compileReviewerInstruction } from "./prompt-compiler.js";
import {
  createReviewerWorkspace,
  removeReviewerWorkspace,
  verifyReviewerWorkspaceImmutable,
} from "./workspace.js";
import {
  ensureExecutionDir,
  readText,
  writeText,
} from "../execution/artifacts.js";

const REVIEWER_CAPS: Capability[] = [
  "repository_read",
  "exact_checkout",
  "command_execution",
];

/**
 * Extract the first complete top-level JSON object from text (strips markdown fences).
 */
export function extractJsonObject(text: string): unknown {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!stripped) {
    throw new SyntaxError("empty reviewer result text");
  }
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const start = stripped.indexOf("{");
    if (start < 0) throw new SyntaxError("no JSON object in reviewer result text");
    // Scan for matching closing brace
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return JSON.parse(stripped.slice(start, i + 1)) as unknown;
        }
      }
    }
    throw new SyntaxError("unterminated JSON object in reviewer result text");
  }
}
export interface GatewayReviewerAdapterOptions {
  binding: ReviewerBinding;
  stateDir: string;
  repoPath: string;
  workspacesRoot: string;
  clock?: { id(prefix?: string): string; now(): string };
  /**
   * When true, never fall back to any fake/scripted reviewer.
   * Real path is always fail-closed. Default true.
   */
  failClosedNoFakeFallback?: boolean;
}

/**
 * Provider-neutral real Independent Reviewer execution boundary.
 * NEVER silently falls back to FakeReviewerAdapter.
 */
export class GatewayReviewerAdapter implements ReviewerAdapter {
  readonly identity: AdapterIdentity = {
    adapter_id: "gateway-reviewer",
    role: "reviewer",
  };

  private probeCache: ReviewerProbeResult = { ok: false, authReady: false };

  constructor(private readonly opts: GatewayReviewerAdapterOptions) {
    if (opts.failClosedNoFakeFallback === false) {
      throw new ControlError(
        "PROTOCOL",
        "GatewayReviewerAdapter must remain fail-closed (no fake fallback)",
      );
    }
  }

  capabilities(): Capability[] {
    return [...REVIEWER_CAPS];
  }

  async refreshProbe(): Promise<ReviewerProbeResult> {
    this.probeCache = await this.opts.binding.probe();
    return this.probeCache;
  }

  preflight(required: Capability[]): PreflightResult {
    const base = defaultPreflight(this.capabilities(), required);
    if (!base.ok) return base;
    // authReady=false MUST prevent runtime spawn
    if (!this.probeCache.ok || !this.probeCache.authReady) {
      return { ok: false, missing: ["command_execution"] };
    }
    return { ok: true, missing: [] };
  }

  get lastProbe(): ReviewerProbeResult {
    return this.probeCache;
  }

  async review(input: ReviewerInput): Promise<unknown> {
    if (!input.dispatch) {
      throw new ControlError(
        "DISPATCH_REQUIRED",
        "Gateway reviewer requires dispatch lease context",
      );
    }

    const targetSha = input.request.body.target_sha;
    if (!targetSha) {
      throw new ControlError(
        "TARGET_SHA_REQUIRED",
        "Reviewer request requires exact target_sha",
      );
    }

    // Fail closed: never spawn when auth not ready
    if (!this.probeCache.authReady) {
      throw new ControlError(
        "CREDENTIAL_UNAVAILABLE",
        "Reviewer authReady=false; refusing runtime spawn",
      );
    }
    if (!this.probeCache.ok) {
      throw new ControlError(
        "AGENT_UNAVAILABLE",
        "Reviewer runtime unavailable",
      );
    }

    const dispatch = input.dispatch;
    const artifacts = ensureExecutionDir(this.opts.stateDir, dispatch.dispatch_id);

    const workspace = createReviewerWorkspace({
      repoPath: this.opts.repoPath,
      targetSha,
      workspacesRoot: this.opts.workspacesRoot,
      cycleId: input.cycle.cycle_id,
      requestId: input.request.request_id!,
      dispatchId: dispatch.dispatch_id,
      attemptNumber: dispatch.attempt_number,
    });

    try {
      const compiled = compileReviewerInstruction({
        request: input.request,
        cycle: input.cycle,
        resultEnvelopeRelPath: artifacts.resultEnvelopePath,
      });
      writeText(artifacts.instructionPath, compiled.text);
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
            target_sha: workspace.targetSha,
            workspace_path: workspace.workspacePath,
            tree_hash_before: workspace.treeHashBefore,
            auth_ready: this.probeCache.authReady,
          },
          null,
          2,
        ),
      );

      const handle = await this.opts.binding.start({
        worktreePath: workspace.workspacePath,
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
        throw new ControlError("RESULT_STALE", "Reviewer dispatch aborted");
      }

      // Immutability gate BEFORE accepting result
      const immutability = verifyReviewerWorkspaceImmutable({
        workspacePath: workspace.workspacePath,
        targetSha: workspace.targetSha,
        treeHashBefore: workspace.treeHashBefore,
      });
      writeText(
        `${artifacts.executionDir}/immutability-proof.json`,
        JSON.stringify(immutability, null, 2),
      );

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
          `Reviewer runtime did not produce parseable JSON${
            lastErr instanceof Error ? `: ${lastErr.message}` : ""
          }`,
        );
      }

      // Correlate before return: schema + target_sha + roles
      const parsed = parseCanonicalEnvelope(raw);
      if (parsed.kind !== "reviewer_result") {
        throw new ControlError(
          "RESULT_INVALID",
          `expected reviewer_result, got ${parsed.kind}`,
        );
      }
      if (parsed.from_role !== "reviewer") {
        throw new ControlError(
          "RESULT_INVALID",
          `from_role must be reviewer, got ${parsed.from_role}`,
        );
      }
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
      const body = parsed.body as ReviewerResultBody;
      if (body.target_sha !== workspace.targetSha) {
        throw new ControlError(
          "RESULT_STALE",
          `reviewer result target_sha ${body.target_sha} != ${workspace.targetSha}`,
        );
      }

      return parsed;
    } catch (err) {
      try {
        removeReviewerWorkspace({
          repoPath: this.opts.repoPath,
          workspacePath: workspace.workspacePath,
        });
      } catch {
        // Best-effort cleanup
      }
      throw err;
    }
  }

  /** Wrap raw body when tests inject body-only payloads. */
  normalizeEnvelope(
    raw: unknown,
    input: ReviewerInput,
  ): Record<string, unknown> {
    if (
      raw != null &&
      typeof raw === "object" &&
      "kind" in raw &&
      (raw as { kind: string }).kind === "reviewer_result"
    ) {
      return raw as Record<string, unknown>;
    }
    const clock = this.opts.clock;
    return {
      protocol: PROTOCOL_V1,
      envelope_id: clock?.id("env") ?? `env_${Date.now()}`,
      kind: "reviewer_result",
      cycle_id: input.cycle.cycle_id,
      request_id: input.request.request_id,
      from_role: "reviewer",
      to_role: "program_control",
      created_at: clock?.now() ?? new Date().toISOString(),
      body: raw,
    };
  }
}
