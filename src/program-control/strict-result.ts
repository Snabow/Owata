import { ControlError } from "../control/types.js";
import {
  PROTOCOL_V1,
  type CanonicalEnvelope,
  type PcDecisionBody,
  type PcDecisionKind,
  type PolicyInstall,
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
  "decision",
  "rationale",
  "authorized_finding_ids",
  "rework_scope",
  "human_gate_purpose",
  "human_gate_choices",
  "install_policy",
]);

const DECISIONS = new Set<PcDecisionKind>([
  "BUILD",
  "REWORK",
  "ACCEPT",
  "RETRY",
  "REDESIGN",
  "HUMAN_GATE",
  "ABORT",
]);

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

function optionalNullableString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  if (!(key in obj)) {
    throw new ControlError("RESULT_INVALID", `${path}.${key} is required`);
  }
  const v = obj[key];
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new ControlError(
    "RESULT_INVALID",
    `${path}.${key} must be string or null`,
  );
}

/**
 * Strict program_control_decision validation at the Gateway boundary.
 * Exact envelope props only; body fields only as protocol PcDecisionBody.
 */
export function assertStrictProgramControlDecision(
  raw: unknown,
): CanonicalEnvelope<PcDecisionBody> {
  if (!isRecord(raw)) {
    throw new ControlError(
      "RESULT_INVALID",
      "program_control_decision must be an object",
    );
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
  if (kind !== "program_control_decision") {
    throw new ControlError(
      "RESULT_INVALID",
      `kind must be program_control_decision, got ${kind}`,
    );
  }
  const fromRole = requireString(raw, "from_role", "envelope");
  if (fromRole !== "program_control") {
    throw new ControlError(
      "RESULT_INVALID",
      `from_role must be program_control, got ${fromRole}`,
    );
  }
  if (!("to_role" in raw)) {
    throw new ControlError("RESULT_INVALID", "to_role is required");
  }
  if (raw.to_role !== "dispatcher") {
    throw new ControlError(
      "RESULT_INVALID",
      `to_role must be dispatcher, got ${String(raw.to_role)}`,
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

  const decisionRaw = requireString(raw.body, "decision", "body");
  if (!DECISIONS.has(decisionRaw as PcDecisionKind)) {
    throw new ControlError(
      "RESULT_INVALID",
      `decision must be a known PcDecisionKind, got ${decisionRaw}`,
    );
  }
  const decision = decisionRaw as PcDecisionKind;

  const rationale = optionalNullableString(raw.body, "rationale", "body");
  const rework_scope = optionalNullableString(raw.body, "rework_scope", "body");
  const human_gate_purpose = optionalNullableString(
    raw.body,
    "human_gate_purpose",
    "body",
  );

  if (!("authorized_finding_ids" in raw.body)) {
    throw new ControlError(
      "RESULT_INVALID",
      "body.authorized_finding_ids is required",
    );
  }
  if (
    !Array.isArray(raw.body.authorized_finding_ids) ||
    raw.body.authorized_finding_ids.some((x) => typeof x !== "string")
  ) {
    throw new ControlError(
      "RESULT_INVALID",
      "body.authorized_finding_ids must be string[]",
    );
  }
  const authorized_finding_ids = raw.body.authorized_finding_ids.map((x) =>
    String(x),
  );
  if (decision === "REWORK" && authorized_finding_ids.length === 0) {
    throw new ControlError(
      "RESULT_INVALID",
      "REWORK decision must identify authorized finding IDs",
    );
  }

  if (!("human_gate_choices" in raw.body)) {
    throw new ControlError(
      "RESULT_INVALID",
      "body.human_gate_choices is required",
    );
  }
  let human_gate_choices: PcDecisionKind[] | null = null;
  if (raw.body.human_gate_choices === null) {
    human_gate_choices = null;
  } else if (Array.isArray(raw.body.human_gate_choices)) {
    human_gate_choices = raw.body.human_gate_choices.map((c) => {
      const s = String(c);
      if (!DECISIONS.has(s as PcDecisionKind)) {
        throw new ControlError(
          "RESULT_INVALID",
          `human_gate_choices contains unknown decision ${s}`,
        );
      }
      return s as PcDecisionKind;
    });
  } else {
    throw new ControlError(
      "RESULT_INVALID",
      "body.human_gate_choices must be array or null",
    );
  }
  if (decision === "HUMAN_GATE" && (!human_gate_choices || human_gate_choices.length === 0)) {
    throw new ControlError(
      "RESULT_INVALID",
      "HUMAN_GATE requires allowed choices",
    );
  }

  if (!("install_policy" in raw.body)) {
    throw new ControlError("RESULT_INVALID", "body.install_policy is required");
  }
  let install_policy: PolicyInstall | null = null;
  if (raw.body.install_policy === null) {
    install_policy = null;
  } else if (isRecord(raw.body.install_policy)) {
    rejectExtraKeys(
      raw.body.install_policy,
      new Set(["on_builder_candidate"]),
      "body.install_policy",
    );
    const v = raw.body.install_policy.on_builder_candidate;
    if (v !== "DISPATCH_REVIEW" && v !== "AWAIT_PC") {
      throw new ControlError(
        "RESULT_INVALID",
        "Unknown install_policy.on_builder_candidate",
      );
    }
    install_policy = { on_builder_candidate: v };
  } else {
    throw new ControlError(
      "RESULT_INVALID",
      "body.install_policy must be object or null",
    );
  }

  return {
    protocol: PROTOCOL_V1,
    envelope_id,
    kind: "program_control_decision",
    cycle_id,
    request_id,
    from_role: "program_control",
    to_role: "dispatcher",
    created_at,
    body: {
      decision,
      rationale,
      authorized_finding_ids,
      rework_scope,
      human_gate_purpose,
      human_gate_choices,
      install_policy,
    },
  };
}
