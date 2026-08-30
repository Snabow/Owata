import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_CAPABILITIES,
  type Capability,
} from "../control/protocol.js";
import {
  PROVIDER_REGISTRY_PROTOCOL,
  ROUTABLE_ROLES,
  RouterError,
  type ProviderBinding,
  type ProviderRegistry,
  type RoutableRole,
} from "./types.js";

const CAPABILITY_SET = new Set<string>(ALL_CAPABILITIES);
const ROUTABLE_SET = new Set<string>(ROUTABLE_ROLES);

const BINDING_KEYS = new Set([
  "binding_id",
  "role",
  "provider_id",
  "runtime_id",
  "model_id",
  "capabilities",
  "priority",
  "enabled",
]);

const ROOT_KEYS = new Set(["protocol", "bindings"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RouterError(
      "REGISTRY_INVALID",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function assertFiniteInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw new RouterError(
      "REGISTRY_INVALID",
      `${field} must be a finite integer`,
    );
  }
  return value;
}

function parseCapabilities(raw: unknown, bindingId: string): Capability[] {
  if (!Array.isArray(raw)) {
    throw new RouterError(
      "REGISTRY_INVALID",
      `binding ${bindingId}: capabilities must be an array`,
    );
  }
  const out: Capability[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !CAPABILITY_SET.has(item)) {
      throw new RouterError(
        "REGISTRY_INVALID",
        `binding ${bindingId}: unknown capability ${String(item)}`,
      );
    }
    if (seen.has(item)) {
      throw new RouterError(
        "REGISTRY_INVALID",
        `binding ${bindingId}: duplicate capability ${item}`,
      );
    }
    seen.add(item);
    out.push(item as Capability);
  }
  return out;
}

function parseBinding(raw: unknown, index: number): ProviderBinding {
  if (!isPlainObject(raw)) {
    throw new RouterError(
      "REGISTRY_INVALID",
      `bindings[${index}] must be an object`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!BINDING_KEYS.has(key)) {
      throw new RouterError(
        "REGISTRY_INVALID",
        `bindings[${index}]: unknown field ${key}`,
      );
    }
  }

  const binding_id = assertNonEmptyString(raw.binding_id, `bindings[${index}].binding_id`);
  const roleRaw = assertNonEmptyString(raw.role, `bindings[${index}].role`);
  if (!ROUTABLE_SET.has(roleRaw)) {
    throw new RouterError(
      "REGISTRY_INVALID",
      `bindings[${index}]: invalid role ${roleRaw}`,
    );
  }
  const role = roleRaw as RoutableRole;
  const provider_id = assertNonEmptyString(
    raw.provider_id,
    `bindings[${index}].provider_id`,
  );
  const runtime_id = assertNonEmptyString(
    raw.runtime_id,
    `bindings[${index}].runtime_id`,
  );

  let model_id: string | undefined;
  if (raw.model_id !== undefined) {
    model_id = assertNonEmptyString(
      raw.model_id,
      `bindings[${index}].model_id`,
    );
  }

  const capabilities = parseCapabilities(raw.capabilities, binding_id);
  const priority = assertFiniteInteger(raw.priority, `bindings[${index}].priority`);
  if (typeof raw.enabled !== "boolean") {
    throw new RouterError(
      "REGISTRY_INVALID",
      `bindings[${index}].enabled must be a boolean`,
    );
  }

  const binding: ProviderBinding = {
    binding_id,
    role,
    provider_id,
    runtime_id,
    capabilities,
    priority,
    enabled: raw.enabled,
  };
  if (model_id !== undefined) {
    binding.model_id = model_id;
  }
  return binding;
}

/**
 * Validate and parse a provider registry document.
 * Fail closed: rejects unknown protocol, unknown fields, duplicates, and malformed types.
 */
export function parseProviderRegistry(raw: unknown): ProviderRegistry {
  if (!isPlainObject(raw)) {
    throw new RouterError("REGISTRY_INVALID", "registry root must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.has(key)) {
      throw new RouterError("REGISTRY_INVALID", `unknown root field ${key}`);
    }
  }
  if (raw.protocol !== PROVIDER_REGISTRY_PROTOCOL) {
    throw new RouterError(
      "REGISTRY_INVALID",
      `unsupported registry protocol ${String(raw.protocol)}`,
    );
  }
  if (!Array.isArray(raw.bindings)) {
    throw new RouterError("REGISTRY_INVALID", "bindings must be an array");
  }

  const bindings: ProviderBinding[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.bindings.length; i++) {
    const binding = parseBinding(raw.bindings[i], i);
    if (seenIds.has(binding.binding_id)) {
      throw new RouterError(
        "REGISTRY_INVALID",
        `duplicate binding_id ${binding.binding_id}`,
      );
    }
    seenIds.add(binding.binding_id);
    bindings.push(binding);
  }

  return {
    protocol: PROVIDER_REGISTRY_PROTOCOL,
    bindings,
  };
}

export function parseProviderRegistryJson(text: string): ProviderRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new RouterError(
      "REGISTRY_INVALID",
      `unreadable registry JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseProviderRegistry(parsed);
}

/**
 * Load and validate a provider registry from an explicit filesystem path.
 * Does not fall back to built-in defaults.
 */
export function loadProviderRegistry(path: string): ProviderRegistry {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new RouterError(
      "REGISTRY_UNREADABLE",
      `cannot read registry at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseProviderRegistryJson(text);
}

/** Default Git-managed registry path under a repository root. */
export function defaultProviderRegistryPath(repoRoot: string): string {
  return join(repoRoot, "config", "provider-registry.json");
}
