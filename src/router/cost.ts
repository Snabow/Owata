import { RouterError } from "./types.js";
import type {
  CostAssessmentResult,
  CostEstimate,
  CostObservation,
  CostProbeResult,
  ProviderBinding,
} from "./types.js";

const AMOUNT_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Single validation authority for CostEstimate syntactic rules. */
export function isValidCostEstimate(value: unknown): value is CostEstimate {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const rec = value as Record<string, unknown>;
  const amount = rec.amount_decimal;
  const currency = rec.currency_code;
  if (typeof amount !== "string" || typeof currency !== "string") {
    return false;
  }
  return AMOUNT_DECIMAL.test(amount) && CURRENCY_CODE.test(currency);
}

function assertNormalizedObservation(obs: CostObservation): void {
  if (obs.state === "UNKNOWN") {
    return;
  }
  // ESTIMATE_AVAILABLE branch of the discriminated union
  if (!isValidCostEstimate(obs.estimate)) {
    throw new RouterError(
      "COST_INVALID",
      `ESTIMATE_AVAILABLE requires syntactically valid estimate for binding_id ${obs.binding_id}`,
    );
  }
}

/**
 * Normalize a structural cost probe into a provider-neutral cost state.
 * Only an explicit syntactically valid estimate becomes ESTIMATE_AVAILABLE.
 * Missing / malformed probes → UNKNOWN (no repair, clamp, uppercase, or inference).
 */
export function normalizeCostEstimate(
  bindingId: string,
  probeResult: CostProbeResult | null | undefined,
): CostObservation {
  if (probeResult == null) {
    return { binding_id: bindingId, state: "UNKNOWN" };
  }
  if (!isValidCostEstimate(probeResult.estimate)) {
    const out: CostObservation = {
      binding_id: bindingId,
      state: "UNKNOWN",
      detail: "malformed cost estimate",
    };
    if (probeResult.detail !== undefined) {
      out.detail = probeResult.detail;
    }
    return out;
  }
  const out: CostObservation = {
    binding_id: bindingId,
    state: "ESTIMATE_AVAILABLE",
    estimate: {
      amount_decimal: probeResult.estimate.amount_decimal,
      currency_code: probeResult.estimate.currency_code,
    },
  };
  if (probeResult.detail !== undefined) {
    out.detail = probeResult.detail;
  }
  return out;
}

/**
 * Optional injected probe helper. Exceptions classify as UNKNOWN.
 * No retry, ranking, persistence, conversion, or live routing.
 */
export async function observeBindingCost(
  bindingId: string,
  probeFn: () => CostProbeResult | Promise<CostProbeResult>,
): Promise<CostObservation> {
  try {
    const probe = await probeFn();
    return normalizeCostEstimate(bindingId, probe);
  } catch (err) {
    return {
      binding_id: bindingId,
      state: "UNKNOWN",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function indexRelevantObservations(
  bindings: readonly ProviderBinding[],
  observations: readonly CostObservation[],
): Map<string, CostObservation> {
  const owned = new Set(bindings.map((b) => b.binding_id));
  const byId = new Map<string, CostObservation>();
  for (const obs of observations) {
    // Unrelated observations are outside assessment ownership: ignore completely
    // (no injection, no COST_INVALID for malformation/duplication).
    if (!owned.has(obs.binding_id)) {
      continue;
    }
    assertNormalizedObservation(obs);
    if (byId.has(obs.binding_id)) {
      throw new RouterError(
        "COST_INVALID",
        `duplicate cost observation for binding_id ${obs.binding_id}`,
      );
    }
    byId.set(obs.binding_id, obs);
  }
  return byId;
}

function observationFor(
  bindingId: string,
  byId: Map<string, CostObservation>,
): CostObservation {
  return byId.get(bindingId) ?? { binding_id: bindingId, state: "UNKNOWN" };
}

/**
 * Partition bindings by cost observation.
 * Preserves input binding order in each partition.
 * Missing observation is UNKNOWN.
 * Unrelated observations (binding_id not in input bindings) are ignored completely.
 * Duplicate / contradictory relevant normalized observations fail closed (COST_INVALID).
 * Partitions are descriptive only — no ranking, conversion, or routing.
 */
export function assessCost(
  bindings: readonly ProviderBinding[],
  observations: readonly CostObservation[],
): CostAssessmentResult {
  const byId = indexRelevantObservations(bindings, observations);

  const resolved: CostObservation[] = [];
  const estimated: ProviderBinding[] = [];
  const unknown: ProviderBinding[] = [];

  for (const binding of bindings) {
    const obs = observationFor(binding.binding_id, byId);
    resolved.push(obs);
    if (obs.state === "ESTIMATE_AVAILABLE") {
      estimated.push(binding);
    } else {
      unknown.push(binding);
    }
  }

  return {
    estimated,
    unknown,
    observations: resolved,
  };
}
