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

export class RouterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}
