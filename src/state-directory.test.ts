import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureStateDirectory } from "./state-directory.js";
import { main, runDoctor } from "./cli.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliJs = join(root, "dist", "cli.js");

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "owata-wp000-r1-"));
}

test("state directory: healthy directory passes", () => {
  const dir = makeTempDir();
  const stateDir = join(dir, ".owata");
  try {
    assert.equal(ensureStateDirectory(stateDir), true);
    assert.equal(ensureStateDirectory(stateDir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state directory: missing path is created and passes", () => {
  const dir = makeTempDir();
  const stateDir = join(dir, "nested", ".owata");
  try {
    assert.equal(existsSync(stateDir), false);
    assert.equal(ensureStateDirectory(stateDir), true);
    assert.equal(existsSync(stateDir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WP000-IR-001: ~/.owata as regular file fails", () => {
  const dir = makeTempDir();
  const stateDir = join(dir, ".owata");
  writeFileSync(stateDir, "not-a-directory\n");
  try {
    assert.equal(ensureStateDirectory(stateDir), false);

    const code = runDoctor(stateDir);
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state directory: invalid parent path fails", () => {
  const dir = makeTempDir();
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "file\n");
  const stateDir = join(blocker, ".owata");
  try {
    assert.equal(ensureStateDirectory(stateDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: healthy state directory passes", () => {
  const dir = makeTempDir();
  const stateDir = join(dir, ".owata");
  mkdirSync(stateDir);
  try {
    const code = runDoctor(stateDir);
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor CLI: regular-file state path reports FAIL and exits 1", () => {
  const dir = makeTempDir();
  const stateDir = join(dir, ".owata");
  writeFileSync(stateDir, "not-a-directory\n");
  try {
    const result = spawnSync(process.execPath, [cliJs, "doctor"], {
      encoding: "utf8",
      env: { ...process.env, OWATA_STATE_DIR: stateDir },
      windowsHide: true,
    });
    assert.match(result.stdout, /\[FAIL\] State directory/);
    assert.equal(result.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor CLI: missing git fails", () => {
  const dir = makeTempDir();
  const stateDir = join(dir, ".owata");
  mkdirSync(stateDir);
  try {
    const result = spawnSync(process.execPath, [cliJs, "doctor"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OWATA_STATE_DIR: stateDir,
        PATH: dir,
        Path: dir,
      },
      windowsHide: true,
    });
    assert.match(result.stdout, /\[FAIL\] Git/);
    assert.equal(result.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owata --version remains PASS", () => {
  const result = spawnSync(process.execPath, [cliJs, "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "owata 0.0.1-genesis\n");
  assert.equal(main(["node", "owata", "--version"]), 0);
});

test("owata status remains PASS", () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-cli-status-"));
  try {
    const result = spawnSync(process.execPath, [cliJs, "status"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, OWATA_STATE_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Project: OWATA/);
    assert.match(result.stdout, /Durable state: ABSENT/);
    assert.doesNotMatch(result.stdout, /State: Genesis/);
    assert.doesNotMatch(result.stdout, /Bootstrap control core/);
    process.env.OWATA_STATE_DIR = dir;
    assert.equal(main(["node", "owata", "status"]), 0);
    delete process.env.OWATA_STATE_DIR;
  } finally {
    delete process.env.OWATA_STATE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
