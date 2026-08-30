import { filterEligibleBindings } from "./eligibility.js";
import { overlayAvailability } from "./availability.js";
import type {
  AvailabilityObservation,
  BindingSelectionResult,
  EligibilityRequest,
  ProviderRegistry,
} from "./types.js";

/**
 * Pure deterministic selection: S1 eligibility → S2 availability → first AVAILABLE.
 * Does not invoke, dispatch, persist, or map to FailureClass / PC decisions.
 */
export function selectBinding(
  registry: ProviderRegistry,
  request: EligibilityRequest,
  observations: readonly AvailabilityObservation[],
): BindingSelectionResult {
  const eligibility = filterEligibleBindings(registry, request);
  const overlay = overlayAvailability(eligibility, observations);

  if (overlay.status === "NO_ELIGIBLE_BINDING") {
    return { status: "NO_ELIGIBLE_BINDING" };
  }
  if (overlay.status === "NO_AVAILABLE_BINDING") {
    return { status: "NO_AVAILABLE_BINDING" };
  }

  const binding = overlay.bindings[0];
  if (binding === undefined) {
    return { status: "NO_AVAILABLE_BINDING" };
  }
  return { status: "SELECTED", binding };
}
