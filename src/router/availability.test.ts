import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PROVIDER_REGISTRY_PROTOCOL,
  filterEligibleBindings,
  normalizeAvailability,
  observeBindingAvailability,
  overlayAvailability,
  type AvailabilityObservation,
  type EligibilityResult,
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

function eligible(...bindings: ProviderBinding[]): EligibilityResult {
  return { status: "ELIGIBLE", bindings };
}

test("ok=true/authReady=true -> AVAILABLE", () => {
  const obs = normalizeAvailability("b1", { ok: true, authReady: true });
  assert.equal(obs.state, "AVAILABLE");
  assert.equal(obs.binding_id, "b1");
});

test("ok=true/authReady=false -> CREDENTIAL_UNAVAILABLE", () => {
  assert.equal(
    normalizeAvailability("b1", { ok: true, authReady: false }).state,
    "CREDENTIAL_UNAVAILABLE",
  );
});

test("ok=false/authReady=false -> AGENT_UNAVAILABLE", () => {
  assert.equal(
    normalizeAvailability("b1", { ok: false, authReady: false }).state,
    "AGENT_UNAVAILABLE",
  );
});

test("ok=false/authReady=true -> AGENT_UNAVAILABLE", () => {
  assert.equal(
    normalizeAvailability("b1", { ok: false, authReady: true }).state,
    "AGENT_UNAVAILABLE",
  );
});

test("missing observation -> UNKNOWN", () => {
  assert.equal(normalizeAvailability("b1", null).state, "UNKNOWN");
  assert.equal(normalizeAvailability("b1", undefined).state, "UNKNOWN");
});

test("S1 NO_ELIGIBLE_BINDING remains NO_ELIGIBLE_BINDING", () => {
  const result = overlayAvailability(
    { status: "NO_ELIGIBLE_BINDING", bindings: [] },
    [{ binding_id: "x", state: "AVAILABLE" }],
  );
  assert.equal(result.status, "NO_ELIGIBLE_BINDING");
  assert.deepEqual(result.bindings, []);
});

test("eligible + all UNKNOWN -> NO_AVAILABLE_BINDING", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = overlayAvailability(eligible(b), []);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
  assert.deepEqual(result.bindings, []);
  assert.equal(result.observations[0]?.state, "UNKNOWN");
});

test("eligible + credential unavailable only -> NO_AVAILABLE_BINDING", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = overlayAvailability(eligible(b), [
    { binding_id: "b1", state: "CREDENTIAL_UNAVAILABLE" },
  ]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
});

test("eligible + agent unavailable only -> NO_AVAILABLE_BINDING", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = overlayAvailability(eligible(b), [
    { binding_id: "b1", state: "AGENT_UNAVAILABLE" },
  ]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
});

test("mixed states returns only AVAILABLE bindings", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const c = binding({ binding_id: "c", priority: 3 });
  const result = overlayAvailability(eligible(a, b, c), [
    { binding_id: "a", state: "CREDENTIAL_UNAVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
    { binding_id: "c", state: "AGENT_UNAVAILABLE" },
  ]);
  assert.equal(result.status, "AVAILABLE");
  assert.deepEqual(
    result.bindings.map((x) => x.binding_id),
    ["b"],
  );
});

test("multiple AVAILABLE bindings preserve exact S1 order", () => {
  const z = binding({ binding_id: "z", priority: 1 });
  const a = binding({ binding_id: "a", priority: 1 });
  const m = binding({ binding_id: "m", priority: 0 });
  const s1 = filterEligibleBindings(registryOf(z, a, m), {
    role: "builder",
    requiredCapabilities: [],
  });
  assert.deepEqual(
    s1.bindings.map((x) => x.binding_id),
    ["m", "a", "z"],
  );
  const result = overlayAvailability(s1, [
    { binding_id: "z", state: "AVAILABLE" },
    { binding_id: "a", state: "AVAILABLE" },
    { binding_id: "m", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    result.bindings.map((x) => x.binding_id),
    ["m", "a", "z"],
  );
});

test("observation insertion order does not alter result", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const elig = eligible(a, b);
  const forward = overlayAvailability(elig, [
    { binding_id: "b", state: "AVAILABLE" },
    { binding_id: "a", state: "AVAILABLE" },
  ]);
  const reverse = overlayAvailability(elig, [
    { binding_id: "a", state: "AVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    forward.bindings.map((x) => x.binding_id),
    ["a", "b"],
  );
  assert.deepEqual(
    reverse.bindings.map((x) => x.binding_id),
    ["a", "b"],
  );
});

test("observation for unrelated binding_id cannot inject a binding", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = overlayAvailability(eligible(a), [
    { binding_id: "intruder", state: "AVAILABLE" },
    { binding_id: "a", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    result.bindings.map((x) => x.binding_id),
    ["a"],
  );
  assert.equal(result.bindings.length, 1);
});

test("provider_id/runtime_id/model_id do not affect availability state", () => {
  const obs = normalizeAvailability("x", {
    ok: true,
    authReady: true,
    detail: "provider=cursor model=whatever",
  });
  assert.equal(obs.state, "AVAILABLE");
  const elig = eligible(
    binding({
      binding_id: "x",
      provider_id: "zzz",
      runtime_id: "zzz-rt",
      model_id: "model-zzz",
      priority: 1,
    }),
    binding({
      binding_id: "y",
      provider_id: "aaa",
      runtime_id: "aaa-rt",
      model_id: "model-aaa",
      priority: 1,
    }),
  );
  const result = overlayAvailability(elig, [
    { binding_id: "y", state: "AVAILABLE" },
    { binding_id: "x", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    result.bindings.map((x) => x.binding_id),
    ["x", "y"],
  );
});

test("generic arbitrary provider/runtime IDs work", () => {
  const b = binding({
    binding_id: "fixture-1",
    provider_id: "acme-cloud",
    runtime_id: "acme-rt",
    priority: 1,
  });
  const result = overlayAvailability(eligible(b), [
    { binding_id: "fixture-1", state: "AVAILABLE" },
  ]);
  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.bindings[0]?.provider_id, "acme-cloud");
});

test("pure overlay does not mutate EligibilityResult input", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const elig: EligibilityResult = eligible(a, b);
  const before = elig.bindings.map((x) => x.binding_id);
  overlayAvailability(elig, [
    { binding_id: "a", state: "AGENT_UNAVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    elig.bindings.map((x) => x.binding_id),
    before,
  );
  assert.equal(elig.status, "ELIGIBLE");
  assert.equal(elig.bindings.length, 2);
});

test("probe exception -> AGENT_UNAVAILABLE; helper performs no retry", async () => {
  let calls = 0;
  const obs = await observeBindingAvailability("b1", () => {
    calls += 1;
    throw new Error("boom");
  });
  assert.equal(obs.state, "AGENT_UNAVAILABLE");
  assert.equal(calls, 1);
  assert.match(obs.detail ?? "", /boom/);
});

test("availability module has no forbidden imports", () => {
  const text = readFileSync(
    join(repoRoot, "src", "router", "availability.ts"),
    "utf8",
  );
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
  ];
  for (const needle of forbidden) {
    assert.equal(text.includes(needle), false, `must not mention ${needle}`);
  }
});

test("observations remain inspectable for later credential vs agent distinction", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = overlayAvailability(eligible(a, b), [
    { binding_id: "a", state: "CREDENTIAL_UNAVAILABLE", detail: "not logged in" },
    { binding_id: "b", state: "AGENT_UNAVAILABLE", detail: "binary missing" },
  ] satisfies AvailabilityObservation[]);
  assert.equal(result.status, "NO_AVAILABLE_BINDING");
  assert.equal(result.observations[0]?.state, "CREDENTIAL_UNAVAILABLE");
  assert.equal(result.observations[1]?.state, "AGENT_UNAVAILABLE");
});
