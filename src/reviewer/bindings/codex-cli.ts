import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ReviewerAttemptSpec,
  ReviewerBinding,
  ReviewerProbeResult,
  ReviewerStartHandle,
  ReviewerWaitResult,
} from "../binding.js";

const execFileAsync = promisify(execFile);

/** Embedded so dist/ does not need a separate JSON copy step.
 * OpenAI response_format schemas require `type` (not bare `const`).
 */
export const REVIEWER_RESULT_OUTPUT_SCHEMA = {
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
    kind: { type: "string", enum: ["reviewer_result"] },
    cycle_id: { type: "string", minLength: 1 },
    request_id: { type: ["string", "null"] },
    from_role: { type: "string", enum: ["reviewer"] },
    to_role: { type: "string", enum: ["program_control"] },
    created_at: { type: "string", minLength: 1 },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["target_sha", "verdict", "findings", "evidence_refs"],
      properties: {
        target_sha: { type: "string", minLength: 1 },
        verdict: { type: "string", enum: ["PASS", "REWORK", "BLOCK"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["finding_id", "severity", "summary"],
            properties: {
              finding_id: { type: "string" },
              severity: { type: "string" },
              summary: { type: "string" },
            },
          },
        },
        evidence_refs: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
} as const;

interface CodexCliHandle extends ReviewerStartHandle {
  process: ChildProcess;
  stdout: string;
  stderr: string;
}

function pathEntries(): string[] {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  return pathEnv.split(delimiter).filter(Boolean);
}

/**
 * Prefer the native codex.exe over npm .cmd/.ps1 shims so stdin is not stolen
 * by the PowerShell wrapper ("Reading additional input from stdin...").
 */
export function resolveCodexBinary(): string {
  const npmRoot = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex")
    : null;
  if (npmRoot && process.platform === "win32") {
    const vendor = join(
      npmRoot,
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    if (existsSync(vendor)) return vendor;
  }

  const preferred =
    process.platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex"]
      : ["codex"];
  for (const dir of pathEntries()) {
    for (const name of preferred) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && !candidate.toLowerCase().endsWith(".ps1")) {
        return candidate;
      }
    }
  }
  throw new Error("Codex binary not found on PATH");
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
 * Codex Champion Independent Reviewer binding.
 * Isolated disposable workspace; read-only sandbox for source; no Builder trust.
 */
export class CodexCliBinding implements ReviewerBinding {
  readonly bindingId = "codex-cli";
  readonly bindingVersion = "1";

  async probe(): Promise<ReviewerProbeResult> {
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

  async start(attempt: ReviewerAttemptSpec): Promise<ReviewerStartHandle> {
    const binary = resolveCodexBinary();
    const schemaPath = join(attempt.artifactsDir, "reviewer-result.schema.json");
    writeFileSync(
      schemaPath,
      `${JSON.stringify(REVIEWER_RESULT_OUTPUT_SCHEMA, null, 2)}\n`,
      "utf8",
    );

    const prompt = [
      `Read the Independent Reviewer instruction file at: ${attempt.instructionPath}`,
      `Follow it exactly.`,
      `Review only the repository at the workspace root (exact candidate SHA already checked out).`,
      `Your FINAL assistant message MUST be ONLY the canonical reviewer_result JSON envelope.`,
      `Do not wrap the JSON in markdown fences. Do not add prose after the JSON.`,
      `Do not modify tracked source files. Do not commit. Do not repair findings.`,
      `Program Control is the sole adjudicator of findings.`,
    ].join("\n");

    // -o is written by the Codex CLI (not the model sandbox) → reliable capture.
    // --output-schema constrains the final message shape.
    // read-only sandbox + --add-dir keeps source immutable while allowing artifact writes.
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-C",
      attempt.worktreePath,
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
        cwd: attempt.worktreePath,
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const handle: CodexCliHandle = {
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

  async wait(handle: ReviewerStartHandle): Promise<ReviewerWaitResult> {
    const cli = handle as CodexCliHandle;
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

  async cancel(handle: ReviewerStartHandle): Promise<void> {
    handle.cancel();
  }
}

/** Test helper: schema file path next to this module when present. */
export function bundledSchemaHint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "reviewer-result.schema.json");
}
