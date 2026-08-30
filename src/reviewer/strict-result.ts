import { ControlError } from "../control/types.js";
import {
  PROTOCOL_V1,
  type CanonicalEnvelope,
  type ReviewerResultBody,
  type ReviewerVerdict,
} from "../control/protocol.js";

const ENVELOPE_KEYS = new Set([
  "protocol",
  "envelope_id",
  "kind",
  "cycle_id",
  "request_id",
  "from_role",
  "to_role",
  "created_at",
  "body",
]);

const BODY_KEYS = new Set([
  "target_sha",
  "verdict",
  "findings",
  "evidence_refs",
]);

const FINDING_KEYS = new Set(["finding_id", "severity", "summary"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function rejectExtraKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ControlError(
        "RESULT_INVALID",
        `additional property not allowed: ${path}.${key}`,
      );
    }
  }
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ControlError(
      "RESULT_INVALID",
      `${path}.${key} must be a non-empty string`,
    );
  }
  return v;
}

/**
 * Strict reviewer_result validation at the Gateway boundary.
 * Does NOT default missing arrays. Enforces to_role=program_control and
 * additionalProperties=false semantics of reviewer-result.schema.json.
 */
export function assertStrictReviewerResult(
  raw: unknown,
): CanonicalEnvelope<ReviewerResultBody> {
  if (!isRecord(raw)) {
    throw new ControlError("RESULT_INVALID", "reviewer_result must be an object");
  }
  rejectExtraKeys(raw, ENVELOPE_KEYS, "envelope");

  const protocol = requireString(raw, "protocol", "envelope");
  if (protocol !== PROTOCOL_V1) {
    throw new ControlError(
      "RESULT_INVALID",
      `protocol must be ${PROTOCOL_V1}`,
    );
  }
  const kind = requireString(raw, "kind", "envelope");
  if (kind !== "reviewer_result") {
    throw new ControlError(
      "RESULT_INVALID",
      `kind must be reviewer_result, got ${kind}`,
    );
  }
  const fromRole = requireString(raw, "from_role", "envelope");
  if (fromRole !== "reviewer") {
    throw new ControlError(
      "RESULT_INVALID",
      `from_role must be reviewer, got ${fromRole}`,
    );
  }
  if (!("to_role" in raw)) {
    throw new ControlError("RESULT_INVALID", "to_role is required");
  }
  if (raw.to_role !== "program_control") {
    throw new ControlError(
      "RESULT_INVALID",
      `to_role must be program_control, got ${String(raw.to_role)}`,
    );
  }

  const envelope_id = requireString(raw, "envelope_id", "envelope");
  const cycle_id = requireString(raw, "cycle_id", "envelope");
  if (!("request_id" in raw)) {
    throw new ControlError("RESULT_INVALID", "request_id is required");
  }
  const request_id =
    raw.request_id === null
      ? null
      : typeof raw.request_id === "string"
        ? raw.request_id
        : (() => {
            throw new ControlError(
              "RESULT_INVALID",
              "request_id must be string or null",
            );
          })();
  const created_at = requireString(raw, "created_at", "envelope");

  if (!isRecord(raw.body)) {
    throw new ControlError("RESULT_INVALID", "body must be an object");
  }
  rejectExtraKeys(raw.body, BODY_KEYS, "body");

  const target_sha = requireString(raw.body, "target_sha", "body");
  const verdict = requireString(raw.body, "verdict", "body") as ReviewerVerdict;
  if (!["PASS", "REWORK", "BLOCK"].includes(verdict)) {
    throw new ControlError(
      "RESULT_INVALID",
      `verdict must be PASS|REWORK|BLOCK, got ${verdict}`,
    );
  }

  if (!("findings" in raw.body)) {
    throw new ControlError("RESULT_INVALID", "body.findings is required");
  }
  if (!Array.isArray(raw.body.findings)) {
    throw new ControlError("RESULT_INVALID", "body.findings must be an array");
  }
  const findings = raw.body.findings.map((item, i) => {
    if (!isRecord(item)) {
      throw new ControlError(
        "RESULT_INVALID",
        `findings[${i}] must be an object`,
      );
    }
    rejectExtraKeys(item, FINDING_KEYS, `findings[${i}]`);
    return {
      finding_id: requireString(item, "finding_id", `findings[${i}]`),
      severity: requireString(item, "severity", `findings[${i}]`),
      summary: requireString(item, "summary", `findings[${i}]`),
    };
  });

  if (!("evidence_refs" in raw.body)) {
    throw new ControlError("RESULT_INVALID", "body.evidence_refs is required");
  }
  if (
    !Array.isArray(raw.body.evidence_refs) ||
    raw.body.evidence_refs.some((x) => typeof x !== "string")
  ) {
    throw new ControlError(
      "RESULT_INVALID",
      "body.evidence_refs must be string[]",
    );
  }
  const evidence_refs = raw.body.evidence_refs.map((x) => String(x));

  return {
    protocol: PROTOCOL_V1,
    envelope_id,
    kind: "reviewer_result",
    cycle_id,
    request_id,
    from_role: "reviewer",
    to_role: "program_control",
    created_at,
    body: {
      target_sha,
      verdict,
      findings,
      evidence_refs,
    },
  };
}
