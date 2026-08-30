import { spawn, execFile, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCodexBinary } from "../../reviewer/bindings/codex-cli.js";
import type {
  ProgramControlAttemptSpec,
  ProgramControlBinding,
  ProgramControlProbeResult,
  ProgramControlStartHandle,
  ProgramControlWaitResult,
} from "../binding.js";

const execFileAsync = promisify(execFile);

/** Embedded so dist/ does not need a separate JSON copy step. */
export const PROGRAM_CONTROL_DECISION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "protocol",
    "envelope_id",
    "kind",
    "cycle_id",
    "request_id",
    "from_role",
    "to_role",
    "created_at",
    "body",
  ],
  properties: {
    protocol: { type: "string", enum: ["owata.handoff/1"] },
    envelope_id: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["program_control_decision"] },
    cycle_id: { type: "string", minLength: 1 },
    request_id: { type: ["string", "null"] },
    from_role: { type: "string", enum: ["program_control"] },
    to_role: { type: "string", enum: ["dispatcher"] },
    created_at: { type: "string", minLength: 1 },
    body: {
      type: "object",
      additionalProperties: false,
      required: [
        "decision",
        "rationale",
        "authorized_finding_ids",
        "rework_scope",
        "human_gate_purpose",
        "human_gate_choices",
        "install_policy",
      ],
      properties: {
        decision: {
          type: "string",
          enum: [
            "BUILD",
            "REWORK",
            "ACCEPT",
            "RETRY",
            "REDESIGN",
            "HUMAN_GATE",
            "ABORT",
          ],
        },
        rationale: { type: ["string", "null"] },
        authorized_finding_ids: {
          type: "array",
          items: { type: "string" },
        },
        rework_scope: { type: ["string", "null"] },
        human_gate_purpose: { type: ["string", "null"] },
        human_gate_choices: {
          type: ["array", "null"],
          items: {
            type: "string",
            enum: [
              "BUILD",
              "REWORK",
              "ACCEPT",
              "RETRY",
              "REDESIGN",
              "HUMAN_GATE",
              "ABORT",
            ],
          },
        },
        install_policy: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["on_builder_candidate"],
          properties: {
            on_builder_candidate: {
              type: "string",
              enum: ["DISPATCH_REVIEW", "AWAIT_PC"],
            },
          },
        },
      },
    },
  },
} as const;

interface CodexCliPcHandle extends ProgramControlStartHandle {
  process: ChildProcess;
  stdout: string;
  stderr: string;
}

async function runCodex(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const binary = resolveCodexBinary();
  const lower = binary.toLowerCase();
  const isCmd = lower.endsWith(".cmd") || lower.endsWith(".bat");
  let file = binary;
  let fileArgs = args;
  if (isCmd) {
    file = process.env.ComSpec ?? "cmd.exe";
    fileArgs = ["/d", "/s", "/c", binary, ...args];
  }
  try {
    const { stdout, stderr } = await execFileAsync(file, fileArgs, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      exitCode: 0,
    };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    return {
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

/**
 * Codex Champion Program Control binding (temporary B2-S2).
 * Separate binding id/session from Independent Reviewer; ephemeral; read-only sandbox.
 * Cursor Builder MUST NOT be used as Program Control.
 */
export class CodexCliProgramControlBinding implements ProgramControlBinding {
  readonly bindingId = "codex-cli-program-control";
  readonly bindingVersion = "1";

  async probe(): Promise<ProgramControlProbeResult> {
    try {
      resolveCodexBinary();
    } catch (err) {
      return {
        ok: false,
        authReady: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    let runtimeVersion: string | undefined;
    let authReady = false;
    let detail: string | undefined;

    try {
      const version = await runCodex(["--version"], 15_000);
      runtimeVersion =
        version.stdout.trim().split(/\r?\n/)[0] ||
        version.stderr.trim().split(/\r?\n/)[0];
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }

    try {
      const status = await runCodex(["login", "status"], 15_000);
      const combined = `${status.stdout}\n${status.stderr}`;
      authReady = /logged in/i.test(combined) && !/not logged in/i.test(combined);
      if (!authReady) {
        detail = combined.trim() || "Codex auth not ready";
      }
    } catch (err) {
      authReady = false;
      detail = err instanceof Error ? err.message : String(err);
    }

    let gitVersion: string | undefined;
    try {
      const git = await execFileAsync("git", ["--version"], {
        timeout: 10_000,
        windowsHide: true,
      });
      gitVersion = String(git.stdout ?? "").trim();
    } catch (err) {
      detail = detail ?? (err instanceof Error ? err.message : String(err));
    }

    const ok = Boolean(runtimeVersion && gitVersion);
    return {
      ok,
      authReady,
      runtimeVersion,
      gitVersion,
      detail,
    };
  }

  async start(
    attempt: ProgramControlAttemptSpec,
  ): Promise<ProgramControlStartHandle> {
    const binary = resolveCodexBinary();
    const schemaPath = join(
      attempt.artifactsDir,
      "program-control-decision.schema.json",
    );
    writeFileSync(
      schemaPath,
      `${JSON.stringify(PROGRAM_CONTROL_DECISION_OUTPUT_SCHEMA, null, 2)}\n`,
      "utf8",
    );

    const prompt = [
      `Read the Program Control instruction file at: ${attempt.instructionPath}`,
      `Follow it exactly.`,
      `ROLE: program_control. You are NOT the Builder and NOT the Independent Reviewer.`,
      `Your FINAL assistant message MUST be ONLY the canonical program_control_decision JSON envelope.`,
      `Do not wrap the JSON in markdown fences. Do not add prose after the JSON.`,
      `Do not modify tracked source files. Do not commit. Do not implement. Do not review as Reviewer.`,
      `Adjudicate from durable envelopes in the instruction only.`,
    ].join("\n");

    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-C",
      attempt.workDir,
      "--add-dir",
      attempt.artifactsDir,
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "-o",
      attempt.resultEnvelopePath,
      prompt,
    ];

    const lower = binary.toLowerCase();
    const isCmd = lower.endsWith(".cmd") || lower.endsWith(".bat");
    const child = spawn(
      isCmd ? (process.env.ComSpec ?? "cmd.exe") : binary,
      isCmd ? ["/d", "/s", "/c", binary, ...args] : args,
      {
        cwd: attempt.workDir,
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const handle: CodexCliPcHandle = {
      pid: child.pid,
      process: child,
      stdout: "",
      stderr: "",
      cancel: () => {
        if (child.pid != null) {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
          } else {
            child.kill("SIGTERM");
          }
        }
      },
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      handle.stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      handle.stderr += chunk.toString("utf8");
    });

    attempt.signal?.addEventListener("abort", () => {
      handle.cancel();
    });

    return handle;
  }

  async wait(handle: ProgramControlStartHandle): Promise<ProgramControlWaitResult> {
    const cli = handle as CodexCliPcHandle;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      cli.process.once("error", reject);
      cli.process.once("exit", (code) => resolve(code));
    });
    return {
      exitCode,
      stdout: cli.stdout,
      stderr: cli.stderr,
    };
  }

  async cancel(handle: ProgramControlStartHandle): Promise<void> {
    handle.cancel();
  }
}

/** Ensure schema write path exists when callers probe filesystem layout. */
export function schemaArtifactName(): string {
  return "program-control-decision.schema.json";
}
