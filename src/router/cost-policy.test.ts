import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_REGISTRY_PROTOCOL,
  RouterError,
  applyCostRoutingConstraint,
  compareDecimalAmounts,
  selectBinding,
  selectBindingWithQuota,
  selectBindingWithQuotaAndCost,
  type AvailabilityObservation,
  type CostObservation,
  type CostRoutingConstraint,
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

function ceiling(amount: string, currency = "USD"): CostRoutingConstraint {
  return {
    max_estimate: { amount_decimal: amount, currency_code: currency },
  };
}

function est(
  bindingId: string,
  amount: string,
  currency = "USD",
): CostObservation {
  return {
    binding_id: bindingId,
    state: "ESTIMATE_AVAILABLE",
    estimate: { amount_decimal: amount, currency_code: currency },
  };
}

function unknownCost(bindingId: string): CostObservation {
  return { binding_id: bindingId, state: "UNKNOWN" };
}

test("constraint: valid 0 / 0.01 USD accepted", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  for (const amount of ["0", "0.01"]) {
    const result = applyCostRoutingConstraint(
      [a],
      [est("a", amount)],
      ceiling("10"),
    );
    assert.equal(result.within_ceiling[0]?.binding_id, "a");
  }
});

test("constraint: invalid forms → COST_INVALID", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const cases: CostRoutingConstraint[] = [
    { max_estimate: { amount_decimal: "-1", currency_code: "USD" } },
    { max_estimate: { amount_decimal: "1e2", currency_code: "USD" } },
    { max_estimate: { amount_decimal: "1.0", currency_code: "usd" } },
    { max_estimate: { amount_decimal: "01", currency_code: "USD" } },
    { max_estimate: { amount_decimal: "1.", currency_code: "USD" } },
  ];
  for (const c of cases) {
    assert.throws(
      () => applyCostRoutingConstraint([a], [est("a", "1")], c),
      (err: unknown) => err instanceof RouterError && err.code === "COST_INVALID",
    );
  }
});

test("compareDecimalAmounts exact forms without float", () => {
  assert.equal(compareDecimalAmounts("0", "0.0"), 0);
  assert.equal(compareDecimalAmounts("0.1", "0.10"), 0);
  assert.equal(compareDecimalAmounts("0.01", "0.1"), -1);
  assert.equal(compareDecimalAmounts("9.9", "10"), -1);
  assert.equal(compareDecimalAmounts("12.5", "12.500"), 0);
  const huge = "1000000000000000000000000000000";
  assert.equal(compareDecimalAmounts(huge, huge), 0);
  assert.equal(compareDecimalAmounts(huge, "999999999999999999999999999999"), 1);
  assert.equal(compareDecimalAmounts("1", "1.000"), 0);
});

test("partitions: WITHIN / OVER / UNKNOWN / CURRENCY_MISMATCH preserve order", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const c = binding({ binding_id: "c", priority: 3 });
  const d = binding({ binding_id: "d", priority: 4 });
  const e = binding({ binding_id: "e", priority: 5 });
  const result = applyCostRoutingConstraint(
    [a, b, c, d, e],
    [
      est("a", "5"),
      est("b", "10"),
      est("c", "10.01"),
      unknownCost("d"),
      est("e", "1", "EUR"),
    ],
    ceiling("10"),
  );
  assert.deepEqual(
    result.within_ceiling.map((x) => x.binding_id),
    ["a", "b"],
  );
  assert.deepEqual(
    result.over_ceiling.map((x) => x.binding_id),
    ["c"],
  );
  assert.deepEqual(
    result.unknown.map((x) => x.binding_id),
    ["d"],
  );
  assert.deepEqual(
    result.currency_mismatch.map((x) => x.binding_id),
    ["e"],
  );
});

test("partitions: relevant invalid / duplicate → COST_INVALID; unrelated ignored", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  assert.throws(
    () =>
      applyCostRoutingConstraint(
        [a],
        [{ binding_id: "a", state: "CREDENTIAL_UNAVAILABLE" } as never],
        ceiling("1"),
      ),
    (err: unknown) => err instanceof RouterError && err.code === "COST_INVALID",
  );
  assert.throws(
    () =>
      applyCostRoutingConstraint(
        [a],
        [est("a", "1"), est("a", "2")],
        ceiling("10"),
      ),
    (err: unknown) => err instanceof RouterError && err.code === "COST_INVALID",
  );
  const ok = applyCostRoutingConstraint(
    [a],
    [
      {
        binding_id: "x",
        state: "CREDENTIAL_UNAVAILABLE",
      } as never,
      est("x", "1"),
      est("x", "2"),
      est("a", "1"),
    ],
    ceiling("10"),
  );
  assert.equal(ok.within_ceiling[0]?.binding_id, "a");
});

test("composition: upstream outcomes preserved", () => {
  const a = binding({ binding_id: "a", role: "reviewer", priority: 1 });
  const none = selectBindingWithQuotaAndCost(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "AVAILABLE" }],
    [est("a", "1")],
    ceiling("10"),
  );
  assert.equal(none.status, "NO_ELIGIBLE_BINDING");

  const b = binding({ binding_id: "b", priority: 1 });
  const noAvail = selectBindingWithQuotaAndCost(
    registry([b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [{ binding_id: "b", state: "UNKNOWN" }],
    [{ binding_id: "b", state: "AVAILABLE" }],
    [est("b", "1")],
    ceiling("10"),
  );
  assert.equal(noAvail.status, "NO_AVAILABLE_BINDING");

  const c = binding({ binding_id: "c", priority: 1 });
  const noQuota = selectBindingWithQuotaAndCost(
    registry([c]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("c")],
    [{ binding_id: "c", state: "EXHAUSTED" }],
    [est("c", "1")],
    ceiling("10"),
  );
  assert.equal(noQuota.status, "NO_QUOTA_ROUTABLE_BINDING");
});

test("composition: all cost OVER / UNKNOWN / mismatch → NO_COST_VERIFIABLE_BINDING", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const over = selectBindingWithQuotaAndCost(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "a", state: "AVAILABLE" },
      { binding_id: "b", state: "AVAILABLE" },
    ],
    [est("a", "20"), est("b", "30")],
    ceiling("10"),
  );
  assert.equal(over.status, "NO_COST_VERIFIABLE_BINDING");

  const unk = selectBindingWithQuotaAndCost(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "AVAILABLE" }],
    [unknownCost("a")],
    ceiling("10"),
  );
  assert.equal(unk.status, "NO_COST_VERIFIABLE_BINDING");

  const mismatch = selectBindingWithQuotaAndCost(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "AVAILABLE" }],
    [est("a", "1", "EUR")],
    ceiling("10"),
  );
  assert.equal(mismatch.status, "NO_COST_VERIFIABLE_BINDING");
});

test("composition: AVAILABLE+WITHIN selected; OVER skipped for later WITHIN", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuotaAndCost(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "a", state: "AVAILABLE" },
      { binding_id: "b", state: "AVAILABLE" },
    ],
    [est("a", "50"), est("b", "5")],
    ceiling("10"),
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "b");
    assert.equal(result.quota_state, "AVAILABLE");
    assert.equal(result.estimate.amount_decimal, "5");
  }
});

test("composition: quota AVAILABLE OVER then UNKNOWN WITHIN → UNKNOWN selected", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuotaAndCost(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "a", state: "AVAILABLE" },
      { binding_id: "b", state: "UNKNOWN" },
    ],
    [est("a", "99"), est("b", "1")],
    ceiling("10"),
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "b");
    assert.equal(result.quota_state, "UNKNOWN");
    assert.equal(result.cost_state, "ESTIMATE_AVAILABLE");
    assert.equal(result.estimate.amount_decimal, "1");
  }
});

test("composition: multiple WITHIN preserve quota-aware order; not cheapest", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuotaAndCost(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a"), avail("b")],
    [
      { binding_id: "a", state: "AVAILABLE" },
      { binding_id: "b", state: "AVAILABLE" },
    ],
    [est("a", "9"), est("b", "1")],
    ceiling("10"),
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "a");
    assert.equal(result.estimate.amount_decimal, "9");
  }
});

test("composition: explicit estimate 0 within ceiling may select", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = selectBindingWithQuotaAndCost(
    registry([a]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [avail("a")],
    [{ binding_id: "a", state: "AVAILABLE" }],
    [est("a", "0")],
    ceiling("0"),
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.estimate.amount_decimal, "0");
  }
});

test("composition: cost for availability-unavailable binding cannot influence", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = selectBindingWithQuotaAndCost(
    registry([a, b]),
    { role: "builder", requiredCapabilities: ["repository_read"] },
    [
      { binding_id: "a", state: "UNKNOWN" },
      avail("b"),
    ],
    [
      { binding_id: "a", state: "AVAILABLE" },
      { binding_id: "b", state: "AVAILABLE" },
    ],
    [est("a", "0"), est("b", "5")],
    ceiling("10"),
  );
  assert.equal(result.status, "SELECTED");
  if (result.status === "SELECTED") {
    assert.equal(result.binding.binding_id, "b");
  }
});

test("regression: selectBinding / selectBindingWithQuota unchanged by cost-policy", () => {
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
  const quota = selectBindingWithQuota(reg, request, observations, [
    { binding_id: "a", state: "UNKNOWN" },
    { binding_id: "b", state: "AVAILABLE" },
  ] as QuotaObservation[]);
  assert.equal(quota.status, "SELECTED");
  if (quota.status === "SELECTED") {
    assert.equal(quota.binding.binding_id, "b");
    assert.equal(quota.quota_state, "AVAILABLE");
  }
});
