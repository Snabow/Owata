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
  selectBinding,
  type AvailabilityObservation,
  type EligibilityRequest,
  type ProviderRegistry,
  type RoutableRole,
} from "../router/index.js";

export type AvailabilityProbeFn = () =>
  | { ok: boolean; authReady: boolean; detail?: string }
  | Promise<{ ok: boolean; authReady: boolean; detail?: string }>;

export type RuntimeCatalogEntry =
  | {
      binding_id: string;
      role: "program_control";
      adapter: ProgramControlAdapter;
      probe: AvailabilityProbeFn;
    }
  | {
      binding_id: string;
      role: "builder";
      adapter: BuilderAdapter;
      probe: AvailabilityProbeFn;
    }
  | {
      binding_id: string;
      role: "reviewer";
      adapter: ReviewerAdapter;
      probe: AvailabilityProbeFn;
    };

export interface RoutingConfig {
  registry: ProviderRegistry;
  catalog: readonly RuntimeCatalogEntry[];
}

/** Router-native pre-dispatch block reasons (A-009; not FailureClass). */
export type RoutingBlockReason =
  | "NO_ELIGIBLE_BINDING"
  | "NO_AVAILABLE_BINDING"
  | "ROUTING_PROVENANCE_MISSING"
  | "ROUTING_CONFIG_INVALID"
  | "PINNED_BINDING_ABSENT"
  | "PINNED_BINDING_INELIGIBLE"
  | "PINNED_BINDING_NOT_IN_CATALOG"
  | "PINNED_BINDING_UNAVAILABLE"
  | "SELECTED_BINDING_NOT_IN_CATALOG";

export interface DurableRoutingObservation {
  binding_id: string;
  state: AvailabilityObservation["state"];
}

export type RoutedBindingOutcome =
  | {
      status: "SELECTED";
      binding_id: string;
      entry: RuntimeCatalogEntry;
      observations: AvailabilityObservation[];
      pinned_binding_id: string | null;
    }
  | {
      status: "BLOCKED";
      reason: RoutingBlockReason;
      observations: AvailabilityObservation[];
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
 * Initial selection: S1 → observe → S3 selectBinding. No failover.
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
      pinned_binding_id: null,
    };
  }

  const observations = await observeEligibleBindings(
    eligibility.bindings,
    args.catalog,
  );
  const selected = selectBinding(args.registry, args.request, observations);
  if (selected.status === "NO_ELIGIBLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_ELIGIBLE_BINDING",
      observations,
      pinned_binding_id: null,
    };
  }
  if (selected.status === "NO_AVAILABLE_BINDING") {
    return {
      status: "BLOCKED",
      reason: "NO_AVAILABLE_BINDING",
      observations,
      pinned_binding_id: null,
    };
  }

  const entry = args.catalog.get(selected.binding.binding_id);
  if (!entry) {
    return {
      status: "BLOCKED",
      reason: "SELECTED_BINDING_NOT_IN_CATALOG",
      observations,
      pinned_binding_id: null,
    };
  }
  if (entry.role !== args.request.role) {
    return {
      status: "BLOCKED",
      reason: "ROUTING_CONFIG_INVALID",
      observations,
      pinned_binding_id: null,
    };
  }

  return {
    status: "SELECTED",
    binding_id: selected.binding.binding_id,
    entry,
    observations,
    pinned_binding_id: null,
  };
}

/**
 * Same-request pin: must use exact prior binding_id; never select another.
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
      pinned_binding_id: pinned,
    };
  }

  const entry = args.catalog.get(pinned);
  if (!entry) {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_NOT_IN_CATALOG",
      observations: [{ binding_id: pinned, state: "UNKNOWN" }],
      pinned_binding_id: pinned,
    };
  }
  if (entry.role !== args.request.role) {
    return {
      status: "BLOCKED",
      reason: "ROUTING_CONFIG_INVALID",
      observations: [{ binding_id: pinned, state: "UNKNOWN" }],
      pinned_binding_id: pinned,
    };
  }

  const obs = await observeBindingAvailability(pinned, entry.probe);
  if (obs.state !== "AVAILABLE") {
    return {
      status: "BLOCKED",
      reason: "PINNED_BINDING_UNAVAILABLE",
      observations: [obs],
      pinned_binding_id: pinned,
    };
  }

  return {
    status: "SELECTED",
    binding_id: pinned,
    entry,
    observations: [obs],
    pinned_binding_id: pinned,
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
