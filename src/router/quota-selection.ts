import { filterEligibleBindings } from "./eligibility.js";
import { overlayAvailability } from "./availability.js";
import { assessQuota } from "./quota.js";
import type {
  AvailabilityObservation,
  EligibilityRequest,
  ProviderRegistry,
  QuotaAwareBindingSelectionResult,
  QuotaObservation,
} from "./types.js";

/**
 * Pure quota-aware selection (S8):
 * S1 eligibility → S2 availability → S6 assessQuota → A-017 policy.
 *
 * Policy: AVAILABLE preferred; UNKNOWN fallback (remains UNKNOWN); EXHAUSTED excluded.
 * Does not change selectBinding(), Dispatcher, or live routing.
 */
export function selectBindingWithQuota(
  registry: ProviderRegistry,
  request: EligibilityRequest,
  availabilityObservations: readonly AvailabilityObservation[],
  quotaObservations: readonly QuotaObservation[],
): QuotaAwareBindingSelectionResult {
  const eligibility = filterEligibleBindings(registry, request);
  const overlay = overlayAvailability(eligibility, availabilityObservations);

  if (overlay.status === "NO_ELIGIBLE_BINDING") {
    return { status: "NO_ELIGIBLE_BINDING" };
  }
  if (overlay.status === "NO_AVAILABLE_BINDING") {
    return { status: "NO_AVAILABLE_BINDING" };
  }

  const assessed = assessQuota(overlay.bindings, quotaObservations);

  const firstAvailable = assessed.available[0];
  if (firstAvailable !== undefined) {
    return {
      status: "SELECTED",
      binding: firstAvailable,
      quota_state: "AVAILABLE",
    };
  }

  const firstUnknown = assessed.unknown[0];
  if (firstUnknown !== undefined) {
    return {
      status: "SELECTED",
      binding: firstUnknown,
      quota_state: "UNKNOWN",
    };
  }

  return { status: "NO_QUOTA_ROUTABLE_BINDING" };
}
