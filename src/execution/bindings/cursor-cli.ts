import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  assertNonClaudeModel,
  isClaudeFamily,
  isAutoRouter,
} from "../model-policy.js";
import type {
  ExecutionAttemptSpec,
  ExecutionBinding,
  ExecutionProbeResult,
  ExecutionStartHandle,
  ExecutionWaitResult,
} from "../binding.js";

const execFileAsync = promisify(execFile);

const PREFERRED_MODELS = [
  /^gpt-5\.6-sol-high$/,
  /^gpt-5\.6-sol-medium$/,
  /^gpt-5\.6-sol/,
  /^composer-2\.5$/,
  /^composer-2\.5-fast$/,
  /^cursor-grok-4\.6-high-fast$/,
  /^cursor-grok-4\.6-high$/,
  /^gpt-5\.3-codex$/,
  /^gemini-3\.7-flash-high$/,
];

function pickPreferredNonClaude(models: string[]): string | undefined {
  const usable = models.filter((id) => !isClaudeFamily(id) && !isAutoRouter(id));
  for (const re of PREFERRED_MODELS) {
    const hit = usable.find((id) => re.test(id));
    if (hit) return hit;
  }
  return usable[0];
}

interface CursorCliHandle extends ExecutionStartHandle {
  process: ChildProcess;
  stdout: string;
  stderr: string;
}

function pathEntries(): string[] {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const localAppData = process.env.LOCALAPPDATA;
  const entries = pathEnv.split(delimiter).filter(Boolean);
  if (localAppData) {
    entries.push(join(localAppData, "cursor-agent"));
  }
  return entries;
}

export function resolveAgentBinary(): string {
  const names =
    process.platform === "win32"
      ? ["agent.exe", "agent.cmd", "agent.ps1", "agent"]
      : ["agent"];
  for (const dir of pathEntries()) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error(
    "Cursor agent binary not found on PATH or %LOCALAPPDATA%\\cursor-agent\\",
  );
}

async function runAgent(args: string[], timeoutMs = 30_000): Promise<{
  stdout: string;
  stderr: string;
}> {
  const binary = resolveAgentBinary();
  const lower = binary.toLowerCase();
  const isPs1 = lower.endsWith(".ps1");
  const isCmd = lower.endsWith(".cmd") || lower.endsWith(".bat");
  let file = binary;
  let fileArgs = args;
  if (isPs1) {
    file = "powershell.exe";
    fileArgs = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      binary,
      ...args,
    ];
  } else if (isCmd) {
    file = process.env.ComSpec ?? "cmd.exe";
    fileArgs = ["/d", "/s", "/c", binary, ...args];
  }
  const { stdout, stderr } = await execFileAsync(file, fileArgs, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    stdout: String(stdout ?? ""),
    stderr: String(stderr ?? ""),
  };
}

function parseModelIds(output: string): string[] {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") ids.add(item);
          else if (item && typeof item === "object" && "id" in item) {
            ids.add(String((item as { id: unknown }).id));
          }
        }
        continue;
      }
      if (parsed && typeof parsed === "object" && "models" in parsed) {
        const models = (parsed as { models: unknown }).models;
        if (Array.isArray(models)) {
          for (const item of models) {
            if (typeof item === "string") ids.add(item);
            else if (item && typeof item === "object" && "id" in item) {
              ids.add(String((item as { id: unknown }).id));
            }
          }
        }
      }
    } catch {
      const token = trimmed.split(/\s+/)[0];
      if (token && !token.startsWith("#")) ids.add(token);
    }
  }
  return [...ids];
}

export class CursorCliBinding implements ExecutionBinding {
  readonly bindingId = "cursor-cli";
  readonly bindingVersion = "1";

  async probe(): Promise<ExecutionProbeResult> {
    try {
      resolveAgentBinary();
    } catch (err) {
      return {
        ok: false,
        authReady: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    let agentVersion: string | undefined;
    let authReady = false;
    let detail: string | undefined;

    try {
      const version = await runAgent(["--version"], 15_000);
      agentVersion = version.stdout.trim() || version.stderr.trim();
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }

    try {
      const status = await runAgent(["status"], 15_000);
      const combined = `${status.stdout}\n${status.stderr}`;
      authReady = !/not logged in/i.test(combined);
      if (!authReady) {
        detail = "Not logged in";
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

    const ok = Boolean(agentVersion && gitVersion);
    return {
      ok,
      authReady,
      agentVersion,
      gitVersion,
      detail,
    };
  }

  async listNonClaudeModels(): Promise<string[]> {
    let output = "";
    try {
      output = (await runAgent(["--list-models"], 30_000)).stdout;
    } catch {
      output = (await runAgent(["models"], 30_000)).stdout;
    }
    return parseModelIds(output).filter(
      (id) => !isClaudeFamily(id) && !isAutoRouter(id),
    );
  }

  async discoverNonClaudeModel(): Promise<string> {
    const models = await this.listNonClaudeModels();
    const chosen = pickPreferredNonClaude(models);
    if (!chosen) {
      throw new Error("NON_CLAUDE_BINDING_UNAVAILABLE: no non-Claude models exposed");
    }
    assertNonClaudeModel(chosen);
    return chosen;
  }

  async start(attempt: ExecutionAttemptSpec): Promise<ExecutionStartHandle> {
    assertNonClaudeModel(attempt.modelId);
    const binary = resolveAgentBinary();
    const prompt = [
      `Read the builder instruction file at: ${attempt.instructionPath}`,
      `Follow it exactly.`,
      `If CANARY_TASK.md exists in the workspace root, execute it verbatim.`,
      `Write the canonical builder_result JSON envelope to: ${attempt.resultEnvelopePath}`,
      `Use only this workspace. Do not use --resume or --continue.`,
    ].join("\n");

    const args = [
      "-p",
      "--force",
      "--trust",
      "--workspace",
      attempt.worktreePath,
      "--output-format",
      "json",
      "--model",
      attempt.modelId,
      prompt,
    ];

    const lower = binary.toLowerCase();
    const isPs1 = lower.endsWith(".ps1");
    const isCmd = lower.endsWith(".cmd") || lower.endsWith(".bat");
    const child = spawn(
      isPs1
        ? "powershell.exe"
        : isCmd
          ? (process.env.ComSpec ?? "cmd.exe")
          : binary,
      isPs1
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", binary, ...args]
        : isCmd
          ? ["/d", "/s", "/c", binary, ...args]
          : args,
      {
        cwd: attempt.worktreePath,
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const handle: CursorCliHandle = {
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

  async wait(handle: ExecutionStartHandle): Promise<ExecutionWaitResult> {
    const cli = handle as CursorCliHandle;
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

  async cancel(handle: ExecutionStartHandle): Promise<void> {
    handle.cancel();
  }
}
