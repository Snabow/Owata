import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_REGISTRY_PROTOCOL,
  selectBinding,
  selectBindingWithQuota,
  type AvailabilityObservation,
  type ProviderBinding,
  type ProviderRegistry,
  type QuotaObservation,
} from "./index.js";

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

function registry(bindings: ProviderBinding[]): ProviderRegistry {
  return { protocol: PROVIDER_REGISTRY_PROTOCOL, bindings };
}

function avail(
  bindingId: string,
  state: AvailabilityObservation["state"] = "AVAILABLE",
): AvailabilityObservation {
  return { binding_id: bindingId, state };
}

test("AVAILABLE only -> selected AVAILABLE", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = selectBindingWithQuota(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "AVAILABLE" }],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "a");
    assert.equal(result.quota_state, "AVAILABLE");
  }
});

test("UNKNOWN only -> selected UNKNOWN with quota_state UNKNOWN", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = selectBindingWithQuota(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "UNKNOWN" }],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "a");
    assert.equal(result.quota_state, "UNKNOWN");
  }
});

test("EXHAUSTED only -> NO_QUOTA_ROUTABLE_BINDING", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = selectBindingWithQuota(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "EXHAUSTED" }],
  );
  assert.equal(result.status, "NO_QUOTA_ROUTABLE_BINDING");
});

test("higher-priority UNKNOWN + lower-priority AVAILABLE -> AVAILABLE", () => {
  const highUnknown = binding({ binding_id: "high", priority: 1 });
  const lowAvailable = binding({ binding_id: "low", priority: 2 });
  const result = selectBindingWithQuota(
    registry([highUnknown, lowAvailable]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("high"), avail("low")],
    [
      { binding_id: "high", state: "UNKNOWN" },
      { binding_id: "low", state: "AVAILABLE" },
    ],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "low");
    assert.equal(result.quota_state, "AVAILABLE");
  }
});

test("multiple AVAILABLE preserve original order", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuota(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "b", state: "AVAILABLE" },
      { binding_id: "a", state: "AVAILABLE" },
    ],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "a");
    assert.equal(result.quota_state, "AVAILABLE");
  }
});

test("no AVAILABLE + multiple UNKNOWN preserve original order", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuota(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "b", state: "UNKNOWN" },
      { binding_id: "a", state: "UNKNOWN" },
    ],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "a");
    assert.equal(result.quota_state, "UNKNOWN");
  }
});

test("AVAILABLE + EXHAUSTED -> AVAILABLE", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuota(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "a", state: "EXHAUSTED" },
      { binding_id: "b", state: "AVAILABLE" },
    ],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "b");
    assert.equal(result.quota_state, "AVAILABLE");
  }
});

test("UNKNOWN + EXHAUSTED -> UNKNOWN", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuota(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "a", state: "EXHAUSTED" },
      { binding_id: "b", state: "UNKNOWN" },
    ],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "b");
    assert.equal(result.quota_state, "UNKNOWN");
  }
});

test("all EXHAUSTED -> NO_QUOTA_ROUTABLE_BINDING", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuota(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "a", state: "EXHAUSTED" },
      { binding_id: "b", state: "EXHAUSTED" },
    ],
  );
  assert.equal(result.status, "NO_QUOTA_ROUTABLE_BINDING");
});

test("no eligible -> NO_ELIGIBLE_BINDING", () => {
  const a = binding({
    binding_id: "a",
    role: "reviewer",
  });
  const result = selectBindingWithQuota(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "AVAILABLE" }],
  );
  assert.equal(result.status, "NO_ELIGIBLE_BINDING");
});

test("eligible but no availability AVAILABLE -> NO_AVAILABLE_BINDING", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = selectBindingWithQuota(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [{ binding_id: "a", state: "UNKNOWN" }],
    [{ binding_id: "a", state: "AVAILABLE" }],
  );
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
});

test("quota for availability-unavailable binding cannot affect result", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuota(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [
      { binding_id: "a", state: "UNKNOWN" },
      avail("b"),
    ],
    [
      { binding_id: "a", state: "AVAILABLE" },
      { binding_id: "b", state: "UNKNOWN" },
    ],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "b");
    assert.equal(result.quota_state, "UNKNOWN");
  }
});

test("selected UNKNOWN is never reported as AVAILABLE", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = selectBindingWithQuota(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [] as QuotaObservation[],
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.quota_state, "UNKNOWN");
  }
});

test("selectBinding semantics unchanged by quota selection module", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const reg = registry([a, b]);
  const request = {
    role: "builder" as const,
    requiredCapabilities: ["repository_read" as const],
  };
  const observations = [avail("a"), avail("b")];
  const classic = selectBinding(reg, request, observations);
  assert.equal(classic.status, "SELECTED");
  if (classic.status === "SELECTED") {
    assert.equal(classic.binding.binding_id, "a");
  }
});
