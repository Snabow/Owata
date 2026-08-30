#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureStateDirectory } from "./state-directory.js";
import { formatStatus, readStatusSnapshot } from "./status.js";
import { ControlError } from "./control/types.js";

const VERSION = "0.0.1-genesis";

export function defaultStateDir(): string {
  return process.env.OWATA_STATE_DIR ?? join(homedir(), ".owata");
}

function printVersion(): void {
  process.stdout.write(`owata ${VERSION}\n`);
}

export function runStatus(stateDir: string = defaultStateDir()): number {
  try {
    const snapshot = readStatusSnapshot(stateDir);
    process.stdout.write(formatStatus(snapshot));
    return 0;
  } catch (err) {
    const message =
      err instanceof ControlError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    process.stderr.write(`owata status failed: ${message}\n`);
    return 1;
  }
}

function checkRuntime(): boolean {
  return typeof process.versions.node === "string" && process.versions.node.length > 0;
}

export function checkGit(): boolean {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

export function runDoctor(stateDir: string = defaultStateDir()): number {
  const checks: Array<{ name: string; ok: boolean }> = [
    { name: "Runtime", ok: checkRuntime() },
    { name: "Git", ok: checkGit() },
    { name: "State directory", ok: ensureStateDirectory(stateDir) },
  ];

  let failed = false;
  for (const check of checks) {
    const mark = check.ok ? "PASS" : "FAIL";
    process.stdout.write(`[${mark}] ${check.name}\n`);
    if (!check.ok) failed = true;
  }

  if (failed) {
    process.stdout.write("OWATA is not ready.\n");
    return 1;
  }

  process.stdout.write("OWATA is ready.\n");
  return 0;
}

function printUsage(): void {
  process.stderr.write("Usage: owata --version | doctor | status\n");
}

export function main(argv: string[]): number {
  const args = argv.slice(2);

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    printVersion();
    return 0;
  }

  if (args.length === 1 && args[0] === "doctor") {
    return runDoctor();
  }

  if (args.length === 1 && args[0] === "status") {
    return runStatus();
  }

  printUsage();
  return 1;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const self = resolve(fileURLToPath(import.meta.url));
if (entry === self) {
  process.exitCode = main(process.argv);
}
