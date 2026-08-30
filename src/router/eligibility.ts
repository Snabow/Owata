import type { Capability } from "../control/protocol.js";
import type {
  EligibilityRequest,
  EligibilityResult,
  ProviderBinding,
  ProviderRegistry,
} from "./types.js";

function hasAllCapabilities(
  supplied: readonly Capability[],
  required: readonly Capability[],
): boolean {
  const set = new Set<string>(supplied);
  for (const cap of required) {
    if (!set.has(cap)) return false;
  }
  return true;
}

function compareEligible(a: ProviderBinding, b: ProviderBinding): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.binding_id < b.binding_id) return -1;
  if (a.binding_id > b.binding_id) return 1;
  return 0;
}

/**
 * Pure deterministic eligibility filter.
 * Does not probe, check auth/quota/cost, consult model-policy, or invoke a binding.
 */
export function filterEligibleBindings(
  registry: ProviderRegistry,
  request: EligibilityRequest,
): EligibilityResult {
  const matched = registry.bindings.filter(
    (b) =>
      b.enabled === true &&
      b.role === request.role &&
      hasAllCapabilities(b.capabilities, request.requiredCapabilities),
  );
  matched.sort(compareEligible);
  if (matched.length === 0) {
    return { status: "NO_ELIGIBLE_BINDING", bindings: [] };
  }
  return { status: "ELIGIBLE", bindings: matched };
}
