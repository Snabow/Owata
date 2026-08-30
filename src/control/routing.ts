import { ControlError } from "./types.js";
import type {
  BuilderAdapter,
  ProgramControlAdapter,
  ReviewerAdapter,
  RoleAdapter,
} from "./adapters.js";
import type { Capability } from "./protocol.js";
import {
  filterEligibleBindings,
  observeBindingAvailability,
  observeBindingQuota,
  selectBindingWithQuota,
  type AvailabilityObservation,
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

export type RuntimeCatalogEntry =
  | {
      binding_id: string;
      role: "program_control";
      adapter: ProgramControlAdapter;
      probe: AvailabilityProbeFn;
      quotaProbe?: QuotaProbeFn;
    }
  | {
      binding_id: string;
      role: "builder";
      adapter: BuilderAdapter;
      probe: AvailabilityProbeFn;
      quotaProbe?: QuotaProbeFn;
    }
  | {
      binding_id: string;
      role: "reviewer";
      adapter: ReviewerAdapter;
      probe: AvailabilityProbeFn;
      quotaProbe?: QuotaProbeFn;
    };

export interface RoutingConfig {
  registry: ProviderRegistry;
  catalog: readonly RuntimeCatalogEntry[];
}

/** Router-native pre-dispatch block reasons (A-009 / A-020 / A-021; not FailureClass). */
export type RoutingBlockReason =
  | "NO_ELIGIBLE_BINDING"
  | "NO_AVAILABLE_BINDING"
  | "NO_QUOTA_ROUTABLE_BINDING"
  | "ROUTING_PROVENANCE_MISSING"
  | "ROUTING_CONFIG_INVALID"
  | "PINNED_BINDING_ABSENT"
  | "PINNED_BINDING_INELIGIBLE"
  | "PINNED_BINDING_NOT_IN_CATALOG"
  | "PINNED_BINDING_UNAVAILABLE"
  | "PINNED_BINDING_QUOTA_EXHAUSTED"
  | "SELECTED_BINDING_NOT_IN_CATALOG";

export interface DurableRoutingObservation {
  binding_id: string;
  state: AvailabilityObservation["state"];
}

export interface DurableQuotaRoutingObservation {
  binding_id: string;
  state: QuotaState;
}

export type RoutedBindingOutcome =
  | {
      status: "SELECTED";
      binding_id: string;
      entry: RuntimeCatalogEntry;
      observations: AvailabilityObservation[];
      quota_observations: QuotaObservation[];
      pinned_binding_id: string | null;
      quota_state?: "AVAILABLE" | "UNKNOWN";
    }
  | {
      status: "BLOCKED";
      reason: RoutingBlockReason;
      observations: AvailabilityObservation[];
      quota_observations: QuotaObservation[];
      pinned_binding_id: string | null;
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
 * Initial selection: S1 → availability → S8 selectBindingWithQuota (A-020).
 * Pre-claim EXHAUSTED skip is routing selection, not failover.
 */
export async function selectRoutedBinding(args: {
  registry: ProviderRegistry;
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>;
  request: EligibilityRequest;
}): Promise<RoutedBindingOutcome> {
  const eligibility = filterEligibleBindings(args.registry, args.request);
  if (eligibility.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations: [],
      quota_observations: [],
      pinned_binding_id: null,
    };
  }

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

  const selected = selectBindingWithQuota(
    args.registry,
    args.request,
    observations,
    quotaObservations,
  );

  if (selected.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      pinned_binding_id: null,
    };
  }
  if (selected.status === "NO_AVAILABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_AVAILABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
      pinned_binding_id: null,
    };
  }
  if (selected.status === "NO_QUOTA_ROUTABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_QUOTA_ROUTABLE_BINDING",
      observations,
      quota_observations: quotaObservations,
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
      pinned_binding_id: null,
    };
  }
  if (entry.role !== args.request.role) {
    return {
      status: "BLOCKED",
      reason: "ROUTING_CONFIG_INVALID",
      observations,
      quota_observations: quotaObservations,
      pinned_binding_id: null,
    };
  }

  return {
    status: "SELECTED",
    binding_id: selected.binding.binding_id,
    entry,
    observations,
    quota_observations: quotaObservations,
    pinned_binding_id: null,
    quota_state: selected.quota_state,
  };
}

/**
 * Same-request pin: exact prior binding_id; quota only on pinned binding (A-021).
 * Never select another binding. EXHAUSTED → PINNED_BINDING_QUOTA_EXHAUSTED.
 */
export async function resolvePinnedBinding(args: {
  registry: ProviderRegistry;
  catalog: ReadonlyMap<string, RuntimeCatalogEntry>;
  request: EligibilityRequest;
  pinnedBindingId: string;
}): Promise<RoutedBindingOutcome> {
  const pinned = args.pinnedBindingId;
  const reg = args.registry.bindings.find((b) => b.binding_id === pinned);
  if (!reg) {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_ABSENT",
      observations: [{ binding_id: pinned, state: "UNKNOWN" }],
      quota_observations: [],
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
      pinned_binding_id: pinned,
    };
  }
  if (entry.role !== args.request.role) {
    return {
      status: "BLOCKED",
      reason: "ROUTING_CONFIG_INVALID",
      observations: [{ binding_id: pinned, state: "UNKNOWN" }],
      quota_observations: [],
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
      pinned_binding_id: pinned,
    };
  }

  return {
    status: "SELECTED",
    binding_id: pinned,
    entry,
    observations: [obs],
    quota_observations: [quotaObs],
    pinned_binding_id: pinned,
    quota_state: quotaObs.state === "AVAILABLE" ? "AVAILABLE" : "UNKNOWN",
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
