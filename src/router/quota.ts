import { RouterError } from "./types.js";
import type {
  ProviderBinding,
  QuotaAssessmentResult,
  QuotaObservation,
  QuotaProbeResult,
  QuotaState,
} from "./types.js";

const VALID_QUOTA_STATES = new Set<QuotaState>([
  "AVAILABLE",
  "EXHAUSTED",
  "UNKNOWN",
]);

/**
 * Normalize a structural quota probe into a provider-neutral quota state.
 * Missing probe → UNKNOWN. Non-boolean exhausted → UNKNOWN (no truthy/falsy coerce).
 * No remaining_tokens / prices / plans / rate windows.
 * S6 does not decide routability; that is S8 policy (DEC-004-009).
 */
export function normalizeQuota(
  bindingId: string,
  probeResult: QuotaProbeResult | null | undefined,
): QuotaObservation {
  if (probeResult == null) {
    return { binding_id: bindingId, state: "UNKNOWN" };
  }
  if (typeof probeResult.exhausted !== "boolean") {
    const out: QuotaObservation = {
      binding_id: bindingId,
      state: "UNKNOWN",
      detail: "malformed quota probe exhausted",
    };
    if (probeResult.detail !== undefined) {
      out.detail = probeResult.detail;
    }
    return out;
  }
  const state: QuotaState = probeResult.exhausted ? "EXHAUSTED" : "AVAILABLE";
  const out: QuotaObservation = { binding_id: bindingId, state };
  if (probeResult.detail !== undefined) {
    out.detail = probeResult.detail;
  }
  return out;
}

/**
 * Optional injected probe helper. Exceptions classify as UNKNOWN.
 * No retry, failover, persistence, or live routing.
 */
export async function observeBindingQuota(
  bindingId: string,
  probeFn: () => QuotaProbeResult | Promise<QuotaProbeResult>,
): Promise<QuotaObservation> {
  try {
    const probe = await probeFn();
    return normalizeQuota(bindingId, probe);
  } catch (err) {
    return {
      binding_id: bindingId,
      state: "UNKNOWN",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function assertNormalizedObservation(obs: QuotaObservation): void {
  const state = (obs as { state?: unknown }).state;
  if (typeof state !== "string" || !VALID_QUOTA_STATES.has(state as QuotaState)) {
    throw new RouterError(
      "QUOTA_INVALID",
      `invalid quota observation state for binding_id ${obs.binding_id}`,
    );
  }
}

function indexRelevantObservations(
  bindings: readonly ProviderBinding[],
  observations: readonly QuotaObservation[],
): Map<string, QuotaObservation> {
  const owned = new Set(bindings.map((b) => b.binding_id));
  const byId = new Map<string, QuotaObservation>();
  for (const obs of observations) {
    // Unrelated observations are outside assessment ownership: ignore completely.
    if (!owned.has(obs.binding_id)) {
      continue;
    }
    assertNormalizedObservation(obs);
    if (byId.has(obs.binding_id)) {
      throw new RouterError(
        "QUOTA_INVALID",
        `duplicate quota observation for binding_id ${obs.binding_id}`,
      );
    }
    byId.set(obs.binding_id, obs);
  }
  return byId;
}

function observationFor(
  bindingId: string,
  byId: Map<string, QuotaObservation>,
): QuotaObservation {
  return byId.get(bindingId) ?? { binding_id: bindingId, state: "UNKNOWN" };
}

/**
 * Partition bindings by quota observation.
 * Preserves input binding order in each partition.
 * Missing observation is UNKNOWN (descriptive; routability is S8 policy).
 * Unrelated observations ignored before validation (cannot inject).
 * Duplicate / invalid relevant normalized observations fail closed (QUOTA_INVALID).
 */
export function assessQuota(
  bindings: readonly ProviderBinding[],
  observations: readonly QuotaObservation[],
): QuotaAssessmentResult {
  const byId = indexRelevantObservations(bindings, observations);

  const resolved: QuotaObservation[] = [];
  const available: ProviderBinding[] = [];
  const exhausted: ProviderBinding[] = [];
  const unknown: ProviderBinding[] = [];

  for (const binding of bindings) {
    const obs = observationFor(binding.binding_id, byId);
    resolved.push(obs);
    if (obs.state === "AVAILABLE") {
      available.push(binding);
    } else if (obs.state === "EXHAUSTED") {
      exhausted.push(binding);
    } else {
      unknown.push(binding);
    }
  }

  return {
    available,
    exhausted,
    unknown,
    observations: resolved,
  };
}
