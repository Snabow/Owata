import { assessCost, isValidCostEstimate } from "./cost.js";
import { filterEligibleBindings } from "./eligibility.js";
import { overlayAvailability } from "./availability.js";
import { assessQuota } from "./quota.js";
import { RouterError } from "./types.js";
import type {
  AvailabilityObservation,
  CostAwareBindingSelectionResult,
  CostConstraintAssessmentResult,
  CostEstimate,
  CostObservation,
  CostRoutingConstraint,
  EligibilityRequest,
  ProviderBinding,
  ProviderRegistry,
  QuotaObservation,
} from "./types.js";

/**
 * Exact comparison of canonical non-negative amount_decimal strings (A-023).
 * No Number / parseFloat / floating-point arithmetic.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareDecimalAmounts(a: string, b: string): -1 | 0 | 1 {
  const na = normalizeAmountParts(a);
  const nb = normalizeAmountParts(b);

  if (na.intDigits.length !== nb.intDigits.length) {
    return na.intDigits.length < nb.intDigits.length ? -1 : 1;
  }
  if (na.intDigits !== nb.intDigits) {
    return na.intDigits < nb.intDigits ? -1 : 1;
  }

  const maxFrac = Math.max(na.fracDigits.length, nb.fracDigits.length);
  const fa = na.fracDigits.padEnd(maxFrac, "0");
  const fb = nb.fracDigits.padEnd(maxFrac, "0");
  if (fa < fb) return -1;
  if (fa > fb) return 1;
  return 0;
}

function normalizeAmountParts(amount: string): {
  intDigits: string;
  fracDigits: string;
} {
  const dot = amount.indexOf(".");
  const intRaw = dot === -1 ? amount : amount.slice(0, dot);
  const fracRaw = dot === -1 ? "" : amount.slice(dot + 1);
  const intDigits = intRaw.replace(/^0+/, "") || "0";
  const fracDigits = fracRaw.replace(/0+$/, "");
  return { intDigits, fracDigits };
}

/** Structural check for CostRoutingConstraint (S7 estimate syntax). No default ceiling. */
export function isValidCostRoutingConstraint(
  constraint: unknown,
): constraint is CostRoutingConstraint {
  return (
    constraint != null &&
    typeof constraint === "object" &&
    isValidCostEstimate(
      (constraint as { max_estimate?: unknown }).max_estimate,
    )
  );
}

function assertCostRoutingConstraint(
  constraint: CostRoutingConstraint,
): CostEstimate {
  if (!isValidCostRoutingConstraint(constraint)) {
    throw new RouterError(
      "COST_INVALID",
      "cost routing constraint.max_estimate must be a canonical CostEstimate",
    );
  }
  return constraint.max_estimate;
}

/**
 * Partition bindings by explicit cost ceiling (A-024).
 * Composes assessCost for normalized observation validation.
 * Same-currency exact decimal compare only; no conversion/ranking.
 */
export function applyCostRoutingConstraint(
  bindings: readonly ProviderBinding[],
  costObservations: readonly CostObservation[],
  constraint: CostRoutingConstraint,
): CostConstraintAssessmentResult {
  const ceiling = assertCostRoutingConstraint(constraint);
  const assessed = assessCost(bindings, costObservations);

  const within_ceiling: ProviderBinding[] = [];
  const over_ceiling: ProviderBinding[] = [];
  const unknown: ProviderBinding[] = [];
  const currency_mismatch: ProviderBinding[] = [];

  const byId = new Map(
    assessed.observations.map((o) => [o.binding_id, o] as const),
  );

  for (const binding of bindings) {
    const obs = byId.get(binding.binding_id) ?? {
      binding_id: binding.binding_id,
      state: "UNKNOWN" as const,
    };
    if (obs.state === "UNKNOWN") {
      unknown.push(binding);
      continue;
    }
    if (obs.estimate.currency_code !== ceiling.currency_code) {
      currency_mismatch.push(binding);
      continue;
    }
    const cmp = compareDecimalAmounts(
      obs.estimate.amount_decimal,
      ceiling.amount_decimal,
    );
    if (cmp <= 0) {
      within_ceiling.push(binding);
    } else {
      over_ceiling.push(binding);
    }
  }

  return {
    within_ceiling,
    over_ceiling,
    unknown,
    currency_mismatch,
    observations: assessed.observations,
  };
}

/**
 * Pure eligibility → availability → quota order → cost ceiling filter (A-025).
 * Does not change selectBinding / selectBindingWithQuota / live Dispatcher.
 */
export function selectBindingWithQuotaAndCost(
  registry: ProviderRegistry,
  request: EligibilityRequest,
  availabilityObservations: readonly AvailabilityObservation[],
  quotaObservations: readonly QuotaObservation[],
  costObservations: readonly CostObservation[],
  constraint: CostRoutingConstraint,
): CostAwareBindingSelectionResult {
  // Validate constraint early (before selection work) so invalid input always fails closed.
  assertCostRoutingConstraint(constraint);

  const eligibility = filterEligibleBindings(registry, request);
  const overlay = overlayAvailability(eligibility, availabilityObservations);

  if (overlay.status === "NO_ELIGIBLE_BINDING") {
    return { status: "NO_ELIGIBLE_BINDING" };
  }
  if (overlay.status === "NO_AVAILABLE_BINDING") {
    return { status: "NO_AVAILABLE_BINDING" };
  }

  const quotaAssessed = assessQuota(overlay.bindings, quotaObservations);
  const quotaOrdered: Array<{
    binding: ProviderBinding;
    quota_state: "AVAILABLE" | "UNKNOWN";
  }> = [
    ...quotaAssessed.available.map((binding) => ({
      binding,
      quota_state: "AVAILABLE" as const,
    })),
    ...quotaAssessed.unknown.map((binding) => ({
      binding,
      quota_state: "UNKNOWN" as const,
    })),
  ];

  if (quotaOrdered.length === 0) {
    return { status: "NO_QUOTA_ROUTABLE_BINDING" };
  }

  const orderedBindings = quotaOrdered.map((x) => x.binding);
  const costAssessed = applyCostRoutingConstraint(
    orderedBindings,
    costObservations,
    constraint,
  );

  const withinIds = new Set(
    costAssessed.within_ceiling.map((b) => b.binding_id),
  );
  const first = quotaOrdered.find((x) => withinIds.has(x.binding.binding_id));
  if (first === undefined) {
    return { status: "NO_COST_VERIFIABLE_BINDING" };
  }

  const obs = costAssessed.observations.find(
    (o) => o.binding_id === first.binding.binding_id,
  );
  if (obs === undefined || obs.state !== "ESTIMATE_AVAILABLE") {
    // Defensive: WITHIN_CEILING requires ESTIMATE_AVAILABLE.
    return { status: "NO_COST_VERIFIABLE_BINDING" };
  }

  return {
    status: "SELECTED",
    binding: first.binding,
    quota_state: first.quota_state,
    cost_state: "ESTIMATE_AVAILABLE",
    estimate: {
      amount_decimal: obs.estimate.amount_decimal,
      currency_code: obs.estimate.currency_code,
    },
  };
}
