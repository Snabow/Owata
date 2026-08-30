import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RouterError,
  assessCost,
  normalizeCostEstimate,
  observeBindingCost,
  selectBinding,
  assessQuota,
  normalizeAvailability,
  type CostObservation,
  type ProviderBinding,
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

test("explicit 0 estimate -> ESTIMATE_AVAILABLE", () => {
  const obs = normalizeCostEstimate("b1", {
    estimate: { amount_decimal: "0", currency_code: "USD" },
  });
  assert.equal(obs.state, "ESTIMATE_AVAILABLE");
  assert.deepEqual(obs.estimate, {
    amount_decimal: "0",
    currency_code: "USD",
  });
});

test("positive integer decimal -> ESTIMATE_AVAILABLE", () => {
  const obs = normalizeCostEstimate("b1", {
    estimate: { amount_decimal: "12", currency_code: "JPY" },
  });
  assert.equal(obs.state, "ESTIMATE_AVAILABLE");
  assert.equal(obs.estimate?.amount_decimal, "12");
});

test("fractional decimal -> ESTIMATE_AVAILABLE", () => {
  const obs = normalizeCostEstimate("b1", {
    estimate: { amount_decimal: "0.01", currency_code: "USD" },
  });
  assert.equal(obs.state, "ESTIMATE_AVAILABLE");
  assert.equal(obs.estimate?.amount_decimal, "0.01");
});

test("null/undefined -> UNKNOWN", () => {
  assert.equal(normalizeCostEstimate("b1", null).state, "UNKNOWN");
  assert.equal(normalizeCostEstimate("b1", undefined).state, "UNKNOWN");
});

test("probe exception -> UNKNOWN; helper performs no retry", async () => {
  let calls = 0;
  const obs = await observeBindingCost("b1", () => {
    calls += 1;
    throw new Error("boom");
  });
  assert.equal(obs.state, "UNKNOWN");
  assert.equal(calls, 1);
  assert.match(obs.detail ?? "", /boom/);
});

test("negative amount -> UNKNOWN", () => {
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "-1", currency_code: "USD" },
    }).state,
    "UNKNOWN",
  );
});

test("signed plus amount -> UNKNOWN", () => {
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "+1", currency_code: "USD" },
    }).state,
    "UNKNOWN",
  );
});

test("exponent amount -> UNKNOWN", () => {
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "1e3", currency_code: "USD" },
    }).state,
    "UNKNOWN",
  );
});

test("NaN/Infinity-like input -> UNKNOWN", () => {
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "NaN", currency_code: "USD" },
    }).state,
    "UNKNOWN",
  );
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "Infinity", currency_code: "USD" },
    }).state,
    "UNKNOWN",
  );
});

test("lowercase currency -> UNKNOWN (no silent uppercase)", () => {
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "1", currency_code: "usd" },
    }).state,
    "UNKNOWN",
  );
});

test("non-three-letter currency -> UNKNOWN", () => {
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "1", currency_code: "US" },
    }).state,
    "UNKNOWN",
  );
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "1", currency_code: "USDT" },
    }).state,
    "UNKNOWN",
  );
});

test("explicit zero preserved; never inferred from missing probe", () => {
  const explicit = normalizeCostEstimate("b1", {
    estimate: { amount_decimal: "0", currency_code: "USD" },
  });
  assert.equal(explicit.state, "ESTIMATE_AVAILABLE");
  if (explicit.state === "ESTIMATE_AVAILABLE") {
    assert.equal(explicit.estimate.amount_decimal, "0");
  }
  const missing = normalizeCostEstimate("b1", null);
  assert.equal(missing.state, "UNKNOWN");
  assert.equal("estimate" in missing, false);
});

test("duplicate binding observation -> COST_INVALID", () => {
  const b = binding({ binding_id: "b1" });
  const obs: CostObservation = {
    binding_id: "b1",
    state: "ESTIMATE_AVAILABLE",
    estimate: { amount_decimal: "1", currency_code: "USD" },
  };
  assert.throws(
    () => assessCost([b], [obs, { ...obs }]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "COST_INVALID",
  );
});

test("assessment preserves input order; partitions exact", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const c = binding({ binding_id: "c", priority: 3 });
  const result = assessCost(
    [a, b, c],
    [
      {
        binding_id: "c",
        state: "ESTIMATE_AVAILABLE",
        estimate: { amount_decimal: "9", currency_code: "USD" },
      },
      {
        binding_id: "a",
        state: "ESTIMATE_AVAILABLE",
        estimate: { amount_decimal: "1", currency_code: "USD" },
      },
    ],
  );
  assert.deepEqual(
    result.estimated.map((x) => x.binding_id),
    ["a", "c"],
  );
  assert.deepEqual(
    result.unknown.map((x) => x.binding_id),
    ["b"],
  );
  assert.deepEqual(
    result.observations.map((x) => x.binding_id),
    ["a", "b", "c"],
  );
});

test("missing observation -> UNKNOWN", () => {
  const b = binding({ binding_id: "b1" });
  const result = assessCost([b], []);
  assert.equal(result.unknown[0]?.binding_id, "b1");
  assert.equal(result.observations[0]?.state, "UNKNOWN");
});

test("unrelated observation cannot inject binding", () => {
  const b = binding({ binding_id: "b1" });
  const result = assessCost(
    [b],
    [
      {
        binding_id: "ghost",
        state: "ESTIMATE_AVAILABLE",
        estimate: { amount_decimal: "99", currency_code: "USD" },
      },
    ],
  );
  assert.deepEqual(
    result.estimated.map((x) => x.binding_id),
    [],
  );
  assert.deepEqual(
    result.unknown.map((x) => x.binding_id),
    ["b1"],
  );
});

test("ESTIMATE_AVAILABLE without estimate -> COST_INVALID", () => {
  const b = binding({ binding_id: "b1" });
  const bad = {
    binding_id: "b1",
    state: "ESTIMATE_AVAILABLE",
  } as unknown as CostObservation;
  assert.throws(
    () => assessCost([b], [bad]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "COST_INVALID",
  );
});

test("ESTIMATE_AVAILABLE malformed negative amount -> COST_INVALID", () => {
  const b = binding({ binding_id: "b1" });
  const bad = {
    binding_id: "b1",
    state: "ESTIMATE_AVAILABLE",
    estimate: { amount_decimal: "-1", currency_code: "USD" },
  } as unknown as CostObservation;
  assert.throws(
    () => assessCost([b], [bad]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "COST_INVALID",
  );
});

test("ESTIMATE_AVAILABLE exponent amount -> COST_INVALID", () => {
  const b = binding({ binding_id: "b1" });
  const bad = {
    binding_id: "b1",
    state: "ESTIMATE_AVAILABLE",
    estimate: { amount_decimal: "1e3", currency_code: "USD" },
  } as unknown as CostObservation;
  assert.throws(
    () => assessCost([b], [bad]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "COST_INVALID",
  );
});

test("ESTIMATE_AVAILABLE lowercase currency -> COST_INVALID", () => {
  const b = binding({ binding_id: "b1" });
  const bad = {
    binding_id: "b1",
    state: "ESTIMATE_AVAILABLE",
    estimate: { amount_decimal: "1", currency_code: "usd" },
  } as unknown as CostObservation;
  assert.throws(
    () => assessCost([b], [bad]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "COST_INVALID",
  );
});

test("valid ESTIMATE_AVAILABLE still enters estimated; UNKNOWN stays unknown", () => {
  const a = binding({ binding_id: "a" });
  const b = binding({ binding_id: "b" });
  const result = assessCost(
    [a, b],
    [
      {
        binding_id: "a",
        state: "ESTIMATE_AVAILABLE",
        estimate: { amount_decimal: "1", currency_code: "USD" },
      },
      { binding_id: "b", state: "UNKNOWN" },
    ],
  );
  assert.deepEqual(
    result.estimated.map((x) => x.binding_id),
    ["a"],
  );
  assert.deepEqual(
    result.unknown.map((x) => x.binding_id),
    ["b"],
  );
});

test("malformed raw probe through normalizeCostEstimate still -> UNKNOWN", () => {
  assert.equal(
    normalizeCostEstimate("b1", {
      estimate: { amount_decimal: "-1", currency_code: "USD" },
    }).state,
    "UNKNOWN",
  );
});

test("no cost ranking occurs (partitions are not sorted by amount)", () => {
  const cheap = binding({ binding_id: "cheap", priority: 1 });
  const expensive = binding({ binding_id: "expensive", priority: 2 });
  const result = assessCost(
    [expensive, cheap],
    [
      {
        binding_id: "expensive",
        state: "ESTIMATE_AVAILABLE",
        estimate: { amount_decimal: "100", currency_code: "USD" },
      },
      {
        binding_id: "cheap",
        state: "ESTIMATE_AVAILABLE",
        estimate: { amount_decimal: "1", currency_code: "USD" },
      },
    ],
  );
  assert.deepEqual(
    result.estimated.map((x) => x.binding_id),
    ["expensive", "cheap"],
  );
});

test("selectBinding / quota / availability unchanged by cost module presence", () => {
  const b = binding({
    binding_id: "b1",
    role: "builder",
    capabilities: ["repository_read"],
  });
  const registry = {
    protocol: "owata.provider-registry/1" as const,
    bindings: [b],
  };
  const selected = selectBinding(
    registry,
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [
      normalizeAvailability("b1", { ok: true, authReady: true }),
    ],
  );
  assert.equal(selected.status, "SELECTED");
  const quota = assessQuota([b], []);
  assert.equal(quota.unknown[0]?.binding_id, "b1");
});

test("provider registry unchanged (no static price fields)", () => {
  const raw = readFileSync(
    join(repoRoot, "config", "provider-registry.json"),
    "utf8",
  );
  assert.doesNotMatch(raw, /price|cost_estimate|amount_decimal/i);
});

test("schema v6 unchanged", () => {
  const schema = readFileSync(
    join(repoRoot, "src", "control", "types.ts"),
    "utf8",
  );
  assert.match(schema, /SCHEMA_VERSION\s*=\s*6/);
  assert.doesNotMatch(schema, /cost_estimate|amount_decimal/);
});
