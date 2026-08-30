import type { Capability } from "../control/protocol.js";

/** Logical roles that S1 may route. Human/dispatcher are never routable. */
export type RoutableRole = "program_control" | "builder" | "reviewer";

export const ROUTABLE_ROLES: readonly RoutableRole[] = [
  "program_control",
  "builder",
  "reviewer",
];

export const PROVIDER_REGISTRY_PROTOCOL = "owata.provider-registry/1";

export interface ProviderBinding {
  binding_id: string;
  role: RoutableRole;
  provider_id: string;
  runtime_id: string;
  model_id?: string;
  capabilities: Capability[];
  priority: number;
  enabled: boolean;
}

export interface ProviderRegistry {
  protocol: typeof PROVIDER_REGISTRY_PROTOCOL;
  bindings: ProviderBinding[];
}

export type EligibilityStatus = "ELIGIBLE" | "NO_ELIGIBLE_BINDING";

export interface EligibilityRequest {
  role: RoutableRole;
  requiredCapabilities: readonly Capability[];
}

export interface EligibilityResult {
  status: EligibilityStatus;
  bindings: ProviderBinding[];
}

/** Provider-neutral probe shape shared across role bindings. */
export interface AvailabilityProbeResult {
  ok: boolean;
  authReady: boolean;
  detail?: string;
}

export type AvailabilityState =
  | "AVAILABLE"
  | "CREDENTIAL_UNAVAILABLE"
  | "AGENT_UNAVAILABLE"
  | "UNKNOWN";

export interface AvailabilityObservation {
  binding_id: string;
  state: AvailabilityState;
  detail?: string;
}

export type AvailabilityOverlayStatus =
  | "AVAILABLE"
  | "NO_ELIGIBLE_BINDING"
  | "NO_AVAILABLE_BINDING";

export interface AvailabilityOverlayResult {
  status: AvailabilityOverlayStatus;
  bindings: ProviderBinding[];
  /** Per eligible binding observation used for this evaluation (ephemeral). */
  observations: AvailabilityObservation[];
}

export type BindingSelectionStatus =
  | "SELECTED"
  | "NO_ELIGIBLE_BINDING"
  | "NO_AVAILABLE_BINDING";

export type BindingSelectionResult =
  | {
      status: "SELECTED";
      binding: ProviderBinding;
    }
  | {
      status: "NO_ELIGIBLE_BINDING";
    }
  | {
      status: "NO_AVAILABLE_BINDING";
    };

/** Provider-neutral quota probe: exhausted flag only (no remaining_tokens / prices / plans). */
export interface QuotaProbeResult {
  exhausted: boolean;
  detail?: string;
}

export type QuotaState = "AVAILABLE" | "EXHAUSTED" | "UNKNOWN";

export interface QuotaObservation {
  binding_id: string;
  state: QuotaState;
  detail?: string;
}

/** Deterministic partition of input bindings by quota observation (input order preserved). */
export interface QuotaAssessmentResult {
  available: ProviderBinding[];
  exhausted: ProviderBinding[];
  unknown: ProviderBinding[];
  /** Per input-binding observation used for this assessment (ephemeral). */
  observations: QuotaObservation[];
}

/**
 * Provider-neutral next-invocation cost estimate.
 * amount_decimal is a base-10 decimal string (no float arithmetic).
 * currency_code is syntactic three uppercase ASCII letters only (no ISO table / conversion).
 */
export interface CostEstimate {
  amount_decimal: string;
  currency_code: string;
}

/** Explicit adapter/provider-owned cost probe. Absence or malformation → UNKNOWN. */
export interface CostProbeResult {
  estimate: CostEstimate;
  detail?: string;
}

export type CostState = "ESTIMATE_AVAILABLE" | "UNKNOWN";

export interface CostObservation {
  binding_id: string;
  state: CostState;
  estimate?: CostEstimate;
  detail?: string;
}

/** Deterministic partition of input bindings by cost observation (input order preserved). */
export interface CostAssessmentResult {
  estimated: ProviderBinding[];
  unknown: ProviderBinding[];
  /** Per input-binding observation used for this assessment (ephemeral). */
  observations: CostObservation[];
}

export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}
