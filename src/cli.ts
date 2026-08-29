#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.0.1-genesis";
const STATE_DIR = join(homedir(), ".owata");

function printVersion(): void {
  process.stdout.write(`owata ${VERSION}\n`);
}

function printStatus(): void {
  process.stdout.write("Project: OWATA\n");
  process.stdout.write("State: Genesis\n");
  process.stdout.write("Next: Bootstrap control core\n");
}

function checkRuntime(): boolean {
  return typeof process.versions.node === "string" && process.versions.node.length > 0;
}

function checkGit(): boolean {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function ensureStateDirectory(): boolean {
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }
    return existsSync(STATE_DIR);
  } catch {
    return false;
  }
}

function printDoctor(): number {
  const checks: Array<{ name: string; ok: boolean }> = [
    { name: "Runtime", ok: checkRuntime() },
    { name: "Git", ok: checkGit() },
    { name: "State directory", ok: ensureStateDirectory() },
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

function main(argv: string[]): number {
  const args = argv.slice(2);

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    printVersion();
    return 0;
  }

  if (args.length === 1 && args[0] === "doctor") {
    return printDoctor();
  }

  if (args.length === 1 && args[0] === "status") {
    printStatus();
    return 0;
  }

  printUsage();
  return 1;
}

process.exitCode = main(process.argv);
