import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlError } from "../control/types.js";
import { assertExactCommitObjectId, resolveExactCommitSha } from "./workspace.js";
import { assertStrictReviewerResult } from "./strict-result.js";
import { PROTOCOL_V1 } from "../control/protocol.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function initRepo(repoPath: string): string {
  mkdirSync(repoPath, { recursive: true });
  git(["init"], repoPath);
  git(["config", "user.email", "test@owata.local"], repoPath);
  git(["config", "user.name", "OWATA Test"], repoPath);
  writeFileSync(join(repoPath, "f.txt"), "x\n", "utf8");
  git(["add", "."], repoPath);
  git(["commit", "-m", "init"], repoPath);
  return git(["rev-parse", "HEAD"], repoPath);
}

test("F02: full exact lowercase commit accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "owata-f02-ok-"));
  try {
    const sha = initRepo(join(root, "repo"));
    assert.equal(assertExactCommitObjectId(sha), sha);
    assert.equal(resolveExactCommitSha(join(root, "repo"), sha), sha);
  } finally {
    cleanup(root);
  }
});

test("F02: uppercase / whitespace / symbolic / short rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "owata-f02-rej-"));
  try {
    const sha = initRepo(join(root, "repo"));
    const repo = join(root, "repo");
    git(["branch", "feature"], repo);
    git(["tag", "v1"], repo);
    const invalidForms = [
      sha.toUpperCase(),
      ` ${sha}`,
      `${sha} `,
      `\t${sha}`,
      `${sha}\n`,
      "HEAD",
      "HEAD~1",
      "HEAD^",
      "feature",
      "v1",
      sha.slice(0, 7),
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ];
    for (const bad of invalidForms) {
      assert.throws(
        () => resolveExactCommitSha(repo, bad),
        (err: unknown) =>
          err instanceof ControlError && err.code === "TARGET_SHA_INVALID",
      );
    }
    assert.throws(
      () =>
        resolveExactCommitSha(
          repo,
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ),
      (err: unknown) =>
        err instanceof ControlError && err.code === "TARGET_SHA_UNRESOLVED",
    );
  } finally {
    cleanup(root);
  }
});

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocol: PROTOCOL_V1,
    envelope_id: "env_1",
    kind: "reviewer_result",
    cycle_id: "cyc_1",
    request_id: "req_1",
    from_role: "reviewer",
    to_role: "program_control",
    created_at: "2026-08-30T00:00:00.000Z",
    body: {
      target_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      verdict: "REWORK",
      findings: [
        { finding_id: "F1", severity: "high", summary: "x" },
      ],
      evidence_refs: [],
    },
    ...overrides,
  };
}

test("F03: valid exact reviewer envelope accepted", () => {
  const parsed = assertStrictReviewerResult(validEnvelope());
  assert.equal(parsed.to_role, "program_control");
  assert.equal(parsed.body.findings.length, 1);
});

test("F03: missing findings / evidence_refs / to_role rejected", () => {
  const missingFindings = validEnvelope();
  delete (missingFindings.body as { findings?: unknown }).findings;
  assert.throws(() => assertStrictReviewerResult(missingFindings));

  const missingEvidence = validEnvelope();
  delete (missingEvidence.body as { evidence_refs?: unknown }).evidence_refs;
  assert.throws(() => assertStrictReviewerResult(missingEvidence));

  const missingToRole = validEnvelope() as Record<string, unknown>;
  delete missingToRole.to_role;
  assert.throws(() => assertStrictReviewerResult(missingToRole));
});

test("F03: to_role=builder and additional properties rejected", () => {
  assert.throws(() =>
    assertStrictReviewerResult(validEnvelope({ to_role: "builder" })),
  );
  assert.throws(() =>
    assertStrictReviewerResult(validEnvelope({ extra: true })),
  );
  const bodyExtra = validEnvelope();
  (bodyExtra.body as Record<string, unknown>).notes = "nope";
  assert.throws(() => assertStrictReviewerResult(bodyExtra));
  const findingExtra = validEnvelope();
  (findingExtra.body.findings[0] as Record<string, unknown>).path = "x";
  assert.throws(() => assertStrictReviewerResult(findingExtra));
});
