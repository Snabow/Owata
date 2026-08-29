import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ExecutionArtifactPaths {
  executionDir: string;
  instructionPath: string;
  runtimeOutputPath: string;
  resultEnvelopePath: string;
  metadataPath: string;
}

export function ensureExecutionDir(
  stateDir: string,
  dispatchId: string,
): ExecutionArtifactPaths {
  const executionDir = join(stateDir, "execution", dispatchId);
  mkdirSync(executionDir, { recursive: true });
  return {
    executionDir,
    instructionPath: join(executionDir, "instruction.txt"),
    runtimeOutputPath: join(executionDir, "runtime-output.txt"),
    resultEnvelopePath: join(executionDir, "result-envelope.json"),
    metadataPath: join(executionDir, "metadata.json"),
  };
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
