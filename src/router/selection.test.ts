import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PROVIDER_REGISTRY_PROTOCOL,
  RouterError,
  selectBinding,
  type AvailabilityObservation,
  type EligibilityRequest,
  type ProviderBinding,
  type ProviderRegistry,
} from "./index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function binding(
  partial: Partial<ProviderBinding> & Pick<ProviderBinding, "binding_id">,
): ProviderBinding {
  return {
    role: "builder",
    provider_id: "prov-a",
    runtime_id: "rt-a",
    capabilities: ["repository_read"],
    priority: 10,
    enabled: true,
    ...partial,
  };
}

function registryOf(...bindings: ProviderBinding[]): ProviderRegistry {
  return { protocol: PROVIDER_REGISTRY_PROTOCOL, bindings };
}

const req: EligibilityRequest = {
  role: "builder",
  requiredCapabilities: ["repository_read"],
};

function freezeSnapshot(
  registry: ProviderRegistry,
  request: EligibilityRequest,
  observations: AvailabilityObservation[],
) {
  return {
    registryJson: JSON.stringify(registry),
    requestJson: JSON.stringify(request),
    observationsJson: JSON.stringify(observations),
  };
}

test("one eligible + AVAILABLE -> SELECTED same binding", () => {
  const b = binding({ binding_id: "only", priority: 1 });
  const result = selectBinding(registryOf(b), req, [
    { binding_id: "only", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "only");
    assert.equal(result.binding, b);
  }
});

test("multiple AVAILABLE -> SELECTED first in exact S1 order", () => {
  const a = binding({ binding_id: "a", priority: 2 });
  const b = binding({ binding_id: "b", priority: 1 });
  const c = binding({ binding_id: "c", priority: 1 });
  const result = selectBinding(registryOf(a, c, b), req, [
    { binding_id: "a", state: "AVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
    { binding_id: "c", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "b");
  }
});

test("config insertion order does not change selected binding", () => {
  const z = binding({ binding_id: "z", priority: 1 });
  const a = binding({ binding_id: "a", priority: 1 });
  const obs: AvailabilityObservation[] = [
    { binding_id: "z", state: "AVAILABLE" },
    { binding_id: "a", state: "AVAILABLE" },
  ];
  const r1 = selectBinding(registryOf(z, a), req, obs);
  const r2 = selectBinding(registryOf(a, z), req, obs);
  assert.equal(r1.status, "SELECTED");
  assert.equal(r2.status, "SELECTED");
  if (r1.status === "SELECTED" && r2.status === "SELECTED") {
    assert.equal(r1.binding.binding_id, "a");
    assert.equal(r2.binding.binding_id, "a");
  }
});

test("availability observation insertion order does not change selection", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const r1 = selectBinding(registryOf(a, b), req, [
    { binding_id: "b", state: "AVAILABLE" },
    { binding_id: "a", state: "AVAILABLE" },
  ]);
  const r2 = selectBinding(registryOf(a, b), req, [
    { binding_id: "a", state: "AVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
  ]);
  assert.equal(r1.status, "SELECTED");
  assert.equal(r2.status, "SELECTED");
  if (r1.status === "SELECTED" && r2.status === "SELECTED") {
    assert.equal(r1.binding.binding_id, "a");
    assert.equal(r2.binding.binding_id, "a");
  }
});

test("unavailable higher-priority skipped; next AVAILABLE selected", () => {
  const hi = binding({ binding_id: "hi", priority: 1 });
  const lo = binding({ binding_id: "lo", priority: 2 });
  const result = selectBinding(registryOf(hi, lo), req, [
    { binding_id: "hi", state: "AGENT_UNAVAILABLE" },
    { binding_id: "lo", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "lo");
  }
});

test("CREDENTIAL_UNAVAILABLE is not selected", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = selectBinding(registryOf(b), req, [
    { binding_id: "b1", state: "CREDENTIAL_UNAVAILABLE" },
  ]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
});

test("AGENT_UNAVAILABLE is not selected", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = selectBinding(registryOf(b), req, [
    { binding_id: "b1", state: "AGENT_UNAVAILABLE" },
  ]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
});

test("UNKNOWN is not selected", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = selectBinding(registryOf(b), req, [
    { binding_id: "b1", state: "UNKNOWN" },
  ]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
});

test("no static eligible binding -> NO_ELIGIBLE_BINDING", () => {
  const off = binding({ binding_id: "off", enabled: false });
  const wrongRole = binding({
    binding_id: "rev",
    role: "reviewer",
    priority: 1,
  });
  const result = selectBinding(registryOf(off, wrongRole), req, [
    { binding_id: "off", state: "AVAILABLE" },
    { binding_id: "rev", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "NO_ELIGIBLE_BINDING");
  assert.equal("binding" in result, false);
});

test("eligible but zero AVAILABLE -> NO_AVAILABLE_BINDING", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = selectBinding(registryOf(b), req, [
    { binding_id: "b1", state: "CREDENTIAL_UNAVAILABLE" },
  ]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
  assert.equal("binding" in result, false);
});

test("NO_ELIGIBLE and NO_AVAILABLE remain distinct", () => {
  const eligibleNone = selectBinding(registryOf(), req, []);
  const availableNone = selectBinding(
    registryOf(binding({ binding_id: "b1", priority: 1 })),
    req,
    [],
  );
  assert.equal(eligibleNone.status, "NO_ELIGIBLE_BINDING");
  assert.equal(availableNone.status, "NO_AVAILABLE_BINDING");
  assert.notEqual(eligibleNone.status, availableNone.status);
});

test("duplicate observation binding_id -> AVAILABILITY_INVALID", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  assert.throws(
    () =>
      selectBinding(registryOf(b), req, [
        { binding_id: "b1", state: "AVAILABLE" },
        { binding_id: "b1", state: "AVAILABLE" },
      ]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "AVAILABILITY_INVALID",
  );
});

test("unrelated AVAILABLE observation cannot inject/select binding", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = selectBinding(registryOf(b), req, [
    { binding_id: "stranger", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
});

test("provider_id does not change selection order", () => {
  const late = binding({
    binding_id: "late",
    priority: 2,
    provider_id: "aaa-first-lex",
  });
  const early = binding({
    binding_id: "early",
    priority: 1,
    provider_id: "zzz-last-lex",
  });
  const result = selectBinding(registryOf(late, early), req, [
    { binding_id: "late", state: "AVAILABLE" },
    { binding_id: "early", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "early");
  }
});

test("runtime_id does not change selection order", () => {
  const a = binding({
    binding_id: "a",
    priority: 1,
    runtime_id: "zzz",
  });
  const b = binding({
    binding_id: "b",
    priority: 1,
    runtime_id: "aaa",
  });
  const result = selectBinding(registryOf(b, a), req, [
    { binding_id: "a", state: "AVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "a");
  }
});

test("model_id does not change selection order", () => {
  const a = binding({
    binding_id: "a",
    priority: 1,
    model_id: "zzz-model",
  });
  const b = binding({
    binding_id: "b",
    priority: 1,
    model_id: "aaa-model",
  });
  const result = selectBinding(registryOf(b, a), req, [
    { binding_id: "a", state: "AVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "a");
  }
});

test("arbitrary generic provider/runtime/model IDs work", () => {
  const b = binding({
    binding_id: "generic-1",
    provider_id: "acme.cloud/v2",
    runtime_id: "runtime://cli-wrapper",
    model_id: "vendor-opaque-model-99",
    priority: 5,
  });
  const result = selectBinding(registryOf(b), req, [
    { binding_id: "generic-1", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.provider_id, "acme.cloud/v2");
    assert.equal(result.binding.runtime_id, "runtime://cli-wrapper");
    assert.equal(result.binding.model_id, "vendor-opaque-model-99");
  }
});

test("inputs are not mutated", () => {
  const b1 = binding({ binding_id: "b1", priority: 2 });
  const b2 = binding({ binding_id: "b2", priority: 1 });
  const registry = registryOf(b1, b2);
  const request: EligibilityRequest = {
    role: "builder",
    requiredCapabilities: ["repository_read"],
  };
  const observations: AvailabilityObservation[] = [
    { binding_id: "b1", state: "AVAILABLE" },
    { binding_id: "b2", state: "AVAILABLE" },
  ];
  const before = freezeSnapshot(registry, request, observations);
  const result = selectBinding(registry, request, observations);
  assert.equal(result.status, "SELECTED");
  assert.equal(JSON.stringify(registry), before.registryJson);
  assert.equal(JSON.stringify(request), before.requestJson);
  assert.equal(JSON.stringify(observations), before.observationsJson);
});

test("selected object is an S1 registry binding instance", () => {
  const b = binding({ binding_id: "canon", priority: 1 });
  const registry = registryOf(b);
  const result = selectBinding(registry, req, [
    { binding_id: "canon", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding, registry.bindings[0]);
  }
});

test("selection has no Dispatcher/Gateway/model-policy/SQLite import surface", () => {
  const src = readFileSync(
    join(repoRoot, "src", "router", "selection.ts"),
    "utf8",
  );
  assert.match(src, /filterEligibleBindings/);
  assert.match(src, /overlayAvailability/);
  const forbidden = [
    "execution/bindings",
    "reviewer/bindings",
    "program-control/bindings",
    "execution/model-policy",
    "control/db",
    "control/dispatcher",
    "execution/gateway",
    "reviewer/gateway",
    "program-control/gateway",
    "node:sqlite",
    "canary/",
  ];
  for (const f of forbidden) {
    assert.equal(src.includes(f), false, `forbidden import surface: ${f}`);
  }
});
