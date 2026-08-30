import type {
  AvailabilityObservation,
  AvailabilityOverlayResult,
  AvailabilityProbeResult,
  AvailabilityState,
  EligibilityResult,
  ProviderBinding,
} from "./types.js";

/**
 * Normalize a structural probe result into a provider-neutral availability state.
 * Runtime unreadiness (ok=false) dominates authReady.
 */
export function normalizeAvailability(
  bindingId: string,
  probeResult: AvailabilityProbeResult | null | undefined,
): AvailabilityObservation {
  if (probeResult == null) {
    return { binding_id: bindingId, state: "UNKNOWN" };
  }
  let state: AvailabilityState;
  if (probeResult.ok === false) {
    state = "AGENT_UNAVAILABLE";
  } else if (probeResult.authReady === true) {
    state = "AVAILABLE";
  } else {
    state = "CREDENTIAL_UNAVAILABLE";
  }
  const out: AvailabilityObservation = { binding_id: bindingId, state };
  if (probeResult.detail !== undefined) {
    out.detail = probeResult.detail;
  }
  return out;
}

/**
 * Optional injected probe helper. Exceptions classify as AGENT_UNAVAILABLE.
 * No retry, failover, or persistence.
 */
export async function observeBindingAvailability(
  bindingId: string,
  probeFn: () =>
    | AvailabilityProbeResult
    | Promise<AvailabilityProbeResult>,
): Promise<AvailabilityObservation> {
  try {
    const probe = await probeFn();
    return normalizeAvailability(bindingId, probe);
  } catch (err) {
    return {
      binding_id: bindingId,
      state: "AGENT_UNAVAILABLE",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function observationFor(
  bindingId: string,
  byId: Map<string, AvailabilityObservation>,
): AvailabilityObservation {
  return byId.get(bindingId) ?? { binding_id: bindingId, state: "UNKNOWN" };
}

/**
 * Overlay ephemeral availability onto an S1 EligibilityResult.
 * Preserves S1 order; only AVAILABLE bindings survive.
 * Missing observation is UNKNOWN (fail-closed), never AVAILABLE.
 */
export function overlayAvailability(
  eligibility: EligibilityResult,
  observations: readonly AvailabilityObservation[],
): AvailabilityOverlayResult {
  if (eligibility.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "NO_ELIGIBLE_BINDING",
      bindings: [],
      observations: [],
    };
  }

  const byId = new Map<string, AvailabilityObservation>();
  for (const obs of observations) {
    // First observation for a binding_id wins; later unrelated entries ignored for ranking.
    if (!byId.has(obs.binding_id)) {
      byId.set(obs.binding_id, obs);
    }
  }

  const resolved: AvailabilityObservation[] = [];
  const available: ProviderBinding[] = [];
  for (const binding of eligibility.bindings) {
    const obs = observationFor(binding.binding_id, byId);
    resolved.push(obs);
    if (obs.state === "AVAILABLE") {
      available.push(binding);
    }
  }

  if (available.length === 0) {
    return {
      status: "NO_AVAILABLE_BINDING",
      bindings: [],
      observations: resolved,
    };
  }
  return {
    status: "AVAILABLE",
    bindings: available,
    observations: resolved,
  };
}
