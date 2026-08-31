import { ControlError } from "./types.js";
import type {
  BuilderAdapter,
  ProgramControlAdapter,
  ReviewerAdapter,
  RoleAdapter,
} from "./adapters.js";
import type { Capability } from "./protocol.js";
import {
  applyCostRoutingConstraint,
  filterEligibleBindings,
  isValidCostRoutingConstraint,
  observeBindingAvailability,
  observeBindingCost,
  observeBindingQuota,
  selectBindingWithQuotaAndCost,
  type AvailabilityObservation,
  type CostEstimate,
  type CostObservation,
  type CostProbeResult,
  type CostRoutingConstraint,
  type EligibilityRequest,
  type ProviderRegistry,
  type QuotaObservation,
  type QuotaProbeResult,
  type QuotaState,
  type RoutableRole,
} from "../router/index.js";

export type AvailabilityProbeFn = () =>
  | { ok: boolean; authReady: boolean; detail?: string }
  | Promise<{ ok: boolean; authReady: boolean; detail?: string }>;

/** Optional live quota probe (A-019). Missing → UNKNOWN (S8 fallback). */
export type QuotaProbeFn = () =>
  | QuotaProbeResult
  | Promise<QuotaProbeResult>;

/** Optional live cost probe (A-027). Missing/exception/malformed → UNKNOWN. */
export type CostProbeFn = () =>
  | CostProbeResult
  | Promise<CostProbeResult>;

export type RuntimeCatalogEntry =
  | {
      binding_id: string;
      role: "program_control";
      adapter: ProgramControlAdapter;
      probe: AvailabilityProbeFn;
      quotaProbe?: QuotaProbeFn;
      costProbe?: CostProbeFn;
    }
  | {
      binding_id: string;
      role: "builder";
      adapter: BuilderAdapter;
      probe: AvailabilityProbeFn;
      quotaProbe?: QuotaProbeFn;
      costProbe?: CostProbeFn;
    }
  | {
      binding_id: string;
      role: "reviewer";
      adapter: ReviewerAdapter;
      probe: AvailabilityProbeFn;
      quotaProbe?: QuotaProbeFn;
      costProbe?: CostProbeFn;
    };

/**
 * Explicit fenced failover opt-in (A-035).
 * Missing → DISABLED (pin / no-alternate). `{ mode: "FENCED" }` → enabled.
 * Malformed → ROUTING_CONFIG_INVALID. Not spend approval.
 */
export type FailoverPolicy = { mode: "FENCED" };

export interface RoutingConfig {
  registry: ProviderRegistry;
  catalog: readonly RuntimeCatalogEntry[];
  /**
   * Optional at the static TypeScript shape for legacy source compatibility.
   * Active routed Dispatcher MUST validate at runtime (A-026): missing/malformed
   * → ROUTING_CONFIG_INVALID. No default ceiling / quota-only fallback.
   */
  costConstraint?: CostRoutingConstraint;
  /**
   * Optional explicit fenced failover (A-035). Absent → DISABLED.
   * Malformed → ROUTING_CONFIG_INVALID at Dispatcher construction / ensureRoutingReady.
   */
  failoverPolicy?: FailoverPolicy;
}

/** Router-native pre-dispatch block reasons (A-009 / A-020 / A-021 / A-028 / A-029; not FailureClass). */
export type RoutingBlockReason =
  | "NO_ELIGIBLE_BINDING"
  | "NO_AVAILABLE_BINDING"
  | "NO_QUOTA_ROUTABLE_BINDING"
  | "NO_COST_VERIFIABLE_BINDING"
  | "ROUTING_PROVENANCE_MISSING"
  | "ROUTING_CONFIG_INVALID"
  | "PINNED_BINDING_ABSENT"
  | "PINNED_BINDING_INELIGIBLE"
  | "PINNED_BINDING_NOT_IN_CATALOG"
  | "PINNED_BINDING_UNAVAILABLE"
  | "PINNED_BINDING_QUOTA_EXHAUSTED"
  | "PINNED_BINDING_COST_NOT_VERIFIABLE"
  | "SELECTED_BINDING_NOT_IN_CATALOG";

export interface DurableRoutingObservation {
  binding_id: string;
  state: AvailabilityObservation["state"];
}

export interface DurableQuotaRoutingObservation {
  binding_id: string;
  state: QuotaState;
}

export interface DurableCostRoutingObservation {
  binding_id: string;
  state: CostObservation["state"];
  estimate?: CostEstimate;
}

export interface DurableCostConstraintSnapshot {
  max_estimate: {
    amount_decimal: string;
    currency_code: string;
  };
}

/**
 * A-034: PRE-ATTRIBUTION escalation evidence state.
 * PRIMARY = selected equals S1 first eligible; ESCALATED = later permitted candidate.
 * Not a quality tier. Not failover.
 */
export type AutomaticEscalationState = "PRIMARY" | "ESCALATED";

/** Compare S1 baseline to live-selected binding (A-031 / A-034). */
export function automaticEscalationState(
  baselineBindingId: string,
  selectedBindingId: string,
): AutomaticEscalationState {
  return selectedBindingId === baselineBindingId ? "PRIMARY" : "ESCALATED";
}

export type RoutedBindingOutcome =
  | {
      status: "SELECTED";
      binding_id: string;
      entry: RuntimeCatalogEntry;
      observations: AvailabilityObservation[];
      quota_observations: QuotaObservation[];
      cost_observations: CostObservation[];
      pinned_binding_id: string | null;
      /** Exact first S1-eligible binding for this request (A-031 baseline). */
      baseline_binding_id: string;
      /** Same as binding_id; explicit for escalation evidence (A-034). */
      selected_binding_id: string;
      /** PRIMARY when selected == baseline; ESCALATED when later candidate (A-034). */
      automatic_escalation: AutomaticEscalationState;
      quota_state?: "AVAILABLE" | "UNKNOWN";
      cost_state: "ESTIMATE_AVAILABLE";
      estimate: CostEstimate;
    }
  | {
      status: "BLOCKED";
      reason: RoutingBlockReason;
      observations: AvailabilityObservation[];
      quota_observations: QuotaObservation[];
      cost_observations: CostObservation[];
      pinned_binding_id: string | null;
    };

/**
 * Fail-closed validation of mandatory costConstraint (A-026).
 * Missing/malformed → ROUTING_CONFIG_INVALID. No default ceiling.
 */
export function requireCostRoutingConstraint(
  constraint: unknown,
): CostRoutingConstraint {
  if (!isValidCostRoutingConstraint(constraint)) {
    throw new ControlError(
      "ROUTING_CONFIG_INVALID",
      "routing costConstraint.max_estimate must be a canonical CostEstimate",
    );
  }
  return {
    max_estimate: {
      amount_decimal: constraint.max_estimate.amount_decimal,
      currency_code: constraint.max_estimate.currency_code,
    },
  };
}

/**
 * Parse optional failoverPolicy (A-035).
 * `undefined` → DISABLED (caller treats as no failover).
 * Present but malformed → ROUTING_CONFIG_INVALID.
 */
export function parseFailoverPolicy(raw: unknown): FailoverPolicy | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ControlError(
      "ROUTING_CONFIG_INVALID",
      "routing failoverPolicy must be { mode: \"FENCED\" } when provided",
    );
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "mode" || obj.mode !== "FENCED") {
    throw new ControlError(
      "ROUTING_CONFIG_INVALID",
      "routing failoverPolicy must be exactly { mode: \"FENCED\" }",
    );
  }
  return { mode: "FENCED" };
}

/** True only for durably terminal prior attempts eligible for fenced failover (A-036). */
export function isFailoverEligiblePrior(dispatch: {
  state: string;
  failure_class: string | null;
}): boolean {
  if (dispatch.state === "EXPIRED") {
    return true;
  }
  if (dispatch.state === "REJECTED") {
    return (
      dispatch.failure_class === "AGENT_UNAVAILABLE" ||
      dispatch.failure_class === "CREDENTIAL_UNAVAILABLE" ||
      dispatch.failure_class === "RUNTIME_ERROR"
    );
  }
  return false;
}

/**
 * Failover selection outcome (A-038). Not S12 escalation evidence.
 * SELECTED never carries automatic_escalation / baseline fields.
 */
export type FailoverBindingOutcome =
  | {
      status: "SELECTED";
      binding_id: string;
      entry: RuntimeCatalogEntry;
      observations: AvailabilityObservation[];
      quota_observations: QuotaObservation[];
      cost_observations: CostObservation[];
      excluded_binding_ids: string[];
      quota_state?: "AVAILABLE" | "UNKNOWN";
      cost_state: "ESTIMATE_AVAILABLE";
      estimate: CostEstimate;
    }
  | {
      status: "BLOCKED";
      reason: RoutingBlockReason;
      observations: AvailabilityObservation[];
      quota_observations: QuotaObservation[];
      cost_observations: CostObservation[];
      excluded_binding_ids: string[];
    };

/**
 * Fail-closed validation of the explicit runtime catalog against the registry.
 * Missing registry bindings without a catalog entry are allowed (UNKNOWN at observe time).
 */
export function validateRuntimeCatalog(
  registry: ProviderRegistry,
  catalog: readonly RuntimeCatalogEntry[],
): void {
  const seen = new Set<string>();
  const byId = new Map(
    registry.bindings.map((b) => [b.binding_id, b] as const),
  );

  for (const entry of catalog) {
    if (typeof entry.binding_id !== "string" || entry.binding_id.length === 0) {
      throw new ControlError(
        "ROUTING_CONFIG_INVALID",
        "runtime catalog binding_id must be a non-empty string",
      );
    }
    if (seen.has(entry.binding_id)) {
      throw new ControlError(
        "ROUTING_CONFIG_INVALID",
        `duplicate runtime catalog binding_id ${entry.binding_id}`,
      );
    }
    seen.add(entry.binding_id);

    if (entry.adapter.identity.role !== entry.role) {
      throw new ControlError(
        "ROUTING_CONFIG_INVALID",
        `catalog role ${entry.role} != adapter.identity.role ${entry.adapter.identity.role} for ${entry.binding_id}`,
      );
    }

    const reg = byId.get(entry.binding_id);
    if (!reg) {
      throw new ControlError(
        "ROUTING_CONFIG_INVALID",
        `runtime catalog binding_id ${entry.binding_id} absent from ProviderRegistry`,
      );
    }
    if (reg.role !== entry.role) {
      throw new ControlError(
        "ROUTING_CONFIG_INVALID",
        `registry role ${reg.role} != catalog role ${entry.role} for ${entry.binding_id}`,
      );
    }
  }
}

export function catalogByBindingId(
  catalog: readonly RuntimeCatalogEntry[],
): Map<string, RuntimeCatalogEntry> {
  return new Map(catalog.map((e) => [e.binding_id, e]));
}

export function sanitizeRoutingObservations(
  observations: readonly AvailabilityObservation[],
): DurableRoutingObservation[] {
  return observations.map((o) => ({
    binding_id: o.binding_id,
    state: o.state,
  }));
}

export function sanitizeQuotaRoutingObservations(
  observations: readonly QuotaObservation[],
): DurableQuotaRoutingObservation[] {
  return observations.map((o) => ({
    binding_id: o.binding_id,
    state: o.state,
  }));
}

/** Sanitized cost observations for routing-block evidence (no raw probe detail). */
export function sanitizeCostRoutingObservations(
  observations: readonly CostObservation[],
): DurableCostRoutingObservation[] {
  return observations.map((o) => {
    if (o.state === "ESTIMATE_AVAILABLE") {
      return {
        binding_id: o.binding_id,
        state: o.state,
        estimate: {
          amount_decimal: o.estimate.amount_decimal,
          currency_code: o.estimate.currency_code,
        },
      };
    }
    return { binding_id: o.binding_id, state: o.state };
  });
}

/** Evaluation-snapshot only; not spend authority. */
export function sanitizeCostConstraintSnapshot(
  constraint: CostRoutingConstraint,
): DurableCostConstraintSnapshot {
  const validated = requireCostRoutingConstraint(constraint);
  return {
    max_estimate: {
      amount_decimal: validated.max_estimate.amount_decimal,
      currency_code: validated.max_estimate.currency_code,
    },
  };
}

/**
 * Produce current availability observations for an S1 eligible set.
 * Catalog entry → observeBindingAvailability(probe); absent → UNKNOWN.
 */
export async function observeEligibleBindings(
  eligibleBindings: readonly { binding_id: string }[],
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>,
): Promise<AvailabilityObservation[]> {
  const observations: AvailabilityObservation[] = [];
  for (const binding of eligibleBindings) {
    const entry = catalog.get(binding.binding_id);
    if (!entry) {
      observations.push({ binding_id: binding.binding_id, state: "UNKNOWN" });
      continue;
    }
    observations.push(
      await observeBindingAvailability(binding.binding_id, entry.probe),
    );
  }
  return observations;
}

/**
 * Quota observations for availability-AVAILABLE candidates only (A-019/A-020).
 * Missing quotaProbe → UNKNOWN. Never probes availability-unavailable bindings.
 */
export async function observeQuotaForAvailableBindings(
  availableBindingIds: readonly string[],
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>,
): Promise<QuotaObservation[]> {
  const observations: QuotaObservation[] = [];
  for (const bindingId of availableBindingIds) {
    const entry = catalog.get(bindingId);
    if (!entry?.quotaProbe) {
      observations.push({ binding_id: bindingId, state: "UNKNOWN" });
      continue;
    }
    observations.push(await observeBindingQuota(bindingId, entry.quotaProbe));
  }
  return observations;
}

/**
 * Cost observations for quota-routable candidates only (A-027/A-028).
 * Quota AVAILABLE then UNKNOWN; EXHAUSTED never probed. Missing costProbe → UNKNOWN.
 */
export async function observeCostForQuotaRoutableBindings(
  quotaObservations: readonly QuotaObservation[],
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>,
): Promise<CostObservation[]> {
  const observations: CostObservation[] = [];
  for (const q of quotaObservations) {
    if (q.state === "EXHAUSTED") {
      continue;
    }
    const entry = catalog.get(q.binding_id);
    if (!entry?.costProbe) {
      observations.push({ binding_id: q.binding_id, state: "UNKNOWN" });
      continue;
    }
    observations.push(await observeBindingCost(q.binding_id, entry.costProbe));
  }
  return observations;
}

/**
 * Initial selection: S1 → availability → quota → cost → S10 selectBindingWithQuotaAndCost (A-028).
 * Pre-claim EXHAUSTED / non-verifiable cost skip is routing selection, not failover.
 * A-031: baseline = first S1 eligible; ESCALATED only when live winner is a later permitted binding.
 */
export async function selectRoutedBinding(args: {
  registry: ProviderRegistry;
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>;
  request: EligibilityRequest;
  costConstraint: CostRoutingConstraint;
}): Promise<RoutedBindingOutcome> {
  const costConstraint = requireCostRoutingConstraint(args.costConstraint);

  const eligibility = filterEligibleBindings(args.registry, args.request);
  if (eligibility.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations: [],
      quota_observations: [],
      cost_observations: [],
      pinned_binding_id: null,
    };
  }

  const baselineBindingId = eligibility.bindings[0]!.binding_id;

  const observations = await observeEligibleBindings(
    eligibility.bindings,
    args.catalog,
  );
  const availableIds = observations
    .filter((o) => o.state === "AVAILABLE")
    .map((o) => o.binding_id);
  const quotaObservations = await observeQuotaForAvailableBindings(
    availableIds,
    args.catalog,
  );
  const costObservations = await observeCostForQuotaRoutableBindings(
    quotaObservations,
    args.catalog,
  );

  const selected = selectBindingWithQuotaAndCost(
    args.registry,
    args.request,
    observations,
    quotaObservations,
    costObservations,
    costConstraint,
  );

  if (selected.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      pinned_binding_id: null,
    };
  }
  if (selected.status === "NO_AVAILABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_AVAILABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      pinned_binding_id: null,
    };
  }
  if (selected.status === "NO_QUOTA_ROUTABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_QUOTA_ROUTABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      pinned_binding_id: null,
    };
  }
  if (selected.status === "NO_COST_VERIFIABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_COST_VERIFIABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      pinned_binding_id: null,
    };
  }

  const entry = args.catalog.get(selected.binding.binding_id);
  if (!entry) {
    return {
      status: "BLOCKED",
      reason: "SELECTED_BINDING_NOT_IN_CATALOG",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      pinned_binding_id: null,
    };
  }
  if (entry.role !== args.request.role) {
    return {
      status: "BLOCKED",
      reason: "ROUTING_CONFIG_INVALID",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      pinned_binding_id: null,
    };
  }

  const selectedBindingId = selected.binding.binding_id;
  return {
    status: "SELECTED",
    binding_id: selectedBindingId,
    entry,
    observations,
    quota_observations: quotaObservations,
    cost_observations: costObservations,
    pinned_binding_id: null,
    baseline_binding_id: baselineBindingId,
    selected_binding_id: selectedBindingId,
    automatic_escalation: automaticEscalationState(
      baselineBindingId,
      selectedBindingId,
    ),
    quota_state: selected.quota_state,
    cost_state: "ESTIMATE_AVAILABLE",
    estimate: selected.estimate,
  };
}

/**
 * Post-terminal alternate selection under FENCED failover (A-038).
 * Excludes every already-attempted binding_id for the request, then runs
 * eligibility → availability → quota → cost on the remaining set.
 * No candidate → BLOCKED (caller enters existing recovery; no fabricate).
 * Does not emit S12 escalation evidence.
 */
export async function selectFailoverBinding(args: {
  registry: ProviderRegistry;
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>;
  request: EligibilityRequest;
  costConstraint: CostRoutingConstraint;
  excludeBindingIds: ReadonlySet<string>;
}): Promise<FailoverBindingOutcome> {
  const costConstraint = requireCostRoutingConstraint(args.costConstraint);
  const excluded = [...args.excludeBindingIds].sort();

  const eligibility = filterEligibleBindings(args.registry, args.request);
  if (eligibility.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations: [],
      quota_observations: [],
      cost_observations: [],
      excluded_binding_ids: excluded,
    };
  }

  const untried = eligibility.bindings.filter(
    (b) => !args.excludeBindingIds.has(b.binding_id),
  );
  if (untried.length === 0) {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations: [],
      quota_observations: [],
      cost_observations: [],
      excluded_binding_ids: excluded,
    };
  }

  // Restrict registry to untried so S10 composition cannot reselect attempted ids.
  const filteredRegistry: ProviderRegistry = {
    protocol: args.registry.protocol,
    bindings: untried,
  };

  const observations = await observeEligibleBindings(untried, args.catalog);
  const availableIds = observations
    .filter((o) => o.state === "AVAILABLE")
    .map((o) => o.binding_id);
  const quotaObservations = await observeQuotaForAvailableBindings(
    availableIds,
    args.catalog,
  );
  const costObservations = await observeCostForQuotaRoutableBindings(
    quotaObservations,
    args.catalog,
  );

  const selected = selectBindingWithQuotaAndCost(
    filteredRegistry,
    args.request,
    observations,
    quotaObservations,
    costObservations,
    costConstraint,
  );

  if (selected.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      excluded_binding_ids: excluded,
    };
  }
  if (selected.status === "NO_AVAILABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_AVAILABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      excluded_binding_ids: excluded,
    };
  }
  if (selected.status === "NO_QUOTA_ROUTABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_QUOTA_ROUTABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      excluded_binding_ids: excluded,
    };
  }
  if (selected.status === "NO_COST_VERIFIABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_COST_VERIFIABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      excluded_binding_ids: excluded,
    };
  }

  const entry = args.catalog.get(selected.binding.binding_id);
  if (!entry) {
    return {
      status: "BLOCKED",
      reason: "SELECTED_BINDING_NOT_IN_CATALOG",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      excluded_binding_ids: excluded,
    };
  }
  if (entry.role !== args.request.role) {
    return {
      status: "BLOCKED",
      reason: "ROUTING_CONFIG_INVALID",
      observations,
      quota_observations: quotaObservations,
      cost_observations: costObservations,
      excluded_binding_ids: excluded,
    };
  }

  return {
    status: "SELECTED",
    binding_id: selected.binding.binding_id,
    entry,
    observations,
    quota_observations: quotaObservations,
    cost_observations: costObservations,
    excluded_binding_ids: excluded,
    quota_state: selected.quota_state,
    cost_state: "ESTIMATE_AVAILABLE",
    estimate: selected.estimate,
  };
}

/**
 * Same-request pin: availability → quota → cost on pinned binding only (A-029).
 * Never select another binding. Cost UNKNOWN/over/mismatch → PINNED_BINDING_COST_NOT_VERIFIABLE.
 */
export async function resolvePinnedBinding(args: {
  registry: ProviderRegistry;
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>;
  request: EligibilityRequest;
  pinnedBindingId: string;
  costConstraint: CostRoutingConstraint;
}): Promise<RoutedBindingOutcome> {
  const costConstraint = requireCostRoutingConstraint(args.costConstraint);
  const pinned = args.pinnedBindingId;
  const reg = args.registry.bindings.find((b) => b.binding_id === pinned);
  if (!reg) {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_ABSENT",
      observations: [{ binding_id: pinned, state: "UNKNOWN" }],
      quota_observations: [],
      cost_observations: [],
      pinned_binding_id: pinned,
    };
  }

  const eligibility = filterEligibleBindings(args.registry, args.request);
  const stillEligible = eligibility.bindings.some(
    (b) => b.binding_id === pinned,
  );
  if (!stillEligible) {
    const observations = await observeEligibleBindings(
      eligibility.bindings,
      args.catalog,
    );
    if (!observations.some((o) => o.binding_id === pinned)) {
      observations.push({ binding_id: pinned, state: "UNKNOWN" });
    }
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_INELIGIBLE",
      observations,
      quota_observations: [],
      cost_observations: [],
      pinned_binding_id: pinned,
    };
  }

  const entry = args.catalog.get(pinned);
  if (!entry) {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_NOT_IN_CATALOG",
      observations: [{ binding_id: pinned, state: "UNKNOWN" }],
      quota_observations: [],
      cost_observations: [],
      pinned_binding_id: pinned,
    };
  }
  if (entry.role !== args.request.role) {
    return {
      status: "BLOCKED",
      reason: "ROUTING_CONFIG_INVALID",
      observations: [{ binding_id: pinned, state: "UNKNOWN" }],
      quota_observations: [],
      cost_observations: [],
      pinned_binding_id: pinned,
    };
  }

  const obs = await observeBindingAvailability(pinned, entry.probe);
  if (obs.state !== "AVAILABLE") {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_UNAVAILABLE",
      observations: [obs],
      quota_observations: [],
      cost_observations: [],
      pinned_binding_id: pinned,
    };
  }

  const quotaObs = entry.quotaProbe
    ? await observeBindingQuota(pinned, entry.quotaProbe)
    : ({ binding_id: pinned, state: "UNKNOWN" } satisfies QuotaObservation);

  if (quotaObs.state === "EXHAUSTED") {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_QUOTA_EXHAUSTED",
      observations: [obs],
      quota_observations: [quotaObs],
      cost_observations: [],
      pinned_binding_id: pinned,
    };
  }

  const costObs = entry.costProbe
    ? await observeBindingCost(pinned, entry.costProbe)
    : ({ binding_id: pinned, state: "UNKNOWN" } satisfies CostObservation);

  const costAssessed = applyCostRoutingConstraint(
    [reg],
    [costObs],
    costConstraint,
  );
  if (costAssessed.within_ceiling.length === 0) {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_COST_NOT_VERIFIABLE",
      observations: [obs],
      quota_observations: [quotaObs],
      cost_observations: [costObs],
      pinned_binding_id: pinned,
    };
  }

  if (costObs.state !== "ESTIMATE_AVAILABLE") {
    // Defensive: WITHIN_CEILING requires ESTIMATE_AVAILABLE.
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_COST_NOT_VERIFIABLE",
      observations: [obs],
      quota_observations: [quotaObs],
      cost_observations: [costObs],
      pinned_binding_id: pinned,
    };
  }

  // A-033: pinned path never escalates; evidence stays PRIMARY on the pin.
  return {
    status: "SELECTED",
    binding_id: pinned,
    entry,
    observations: [obs],
    quota_observations: [quotaObs],
    cost_observations: [costObs],
    pinned_binding_id: pinned,
    baseline_binding_id: pinned,
    selected_binding_id: pinned,
    automatic_escalation: "PRIMARY",
    quota_state: quotaObs.state === "AVAILABLE" ? "AVAILABLE" : "UNKNOWN",
    cost_state: "ESTIMATE_AVAILABLE",
    estimate: {
      amount_decimal: costObs.estimate.amount_decimal,
      currency_code: costObs.estimate.currency_code,
    },
  };
}

export function eligibilityRequestFor(
  role: RoutableRole,
  requiredCapabilities: readonly Capability[],
): EligibilityRequest {
  return { role, requiredCapabilities: [...requiredCapabilities] };
}

export function asRoleAdapter(entry: RuntimeCatalogEntry): RoleAdapter {
  return entry.adapter;
}
