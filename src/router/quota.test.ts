import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RouterError,
  assessQuota,
  normalizeQuota,
  observeBindingQuota,
  type ProviderBinding,
  type QuotaObservation,
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

test("exhausted=false -> AVAILABLE", () => {
  const obs = normalizeQuota("b1", { exhausted: false });
  assert.equal(obs.state, "AVAILABLE");
  assert.equal(obs.binding_id, "b1");
});

test("exhausted=true -> EXHAUSTED", () => {
  assert.equal(normalizeQuota("b1", { exhausted: true }).state, "EXHAUSTED");
});

test("missing probe -> UNKNOWN", () => {
  assert.equal(normalizeQuota("b1", null).state, "UNKNOWN");
  assert.equal(normalizeQuota("b1", undefined).state, "UNKNOWN");
});

test("detail is preserved when present", () => {
  const obs = normalizeQuota("b1", {
    exhausted: false,
    detail: "ok-window",
  });
  assert.equal(obs.detail, "ok-window");
});

test("probe exception -> UNKNOWN; helper performs no retry", async () => {
  let calls = 0;
  const obs = await observeBindingQuota("b1", () => {
    calls += 1;
    throw new Error("boom");
  });
  assert.equal(obs.state, "UNKNOWN");
  assert.equal(calls, 1);
  assert.match(obs.detail ?? "", /boom/);
});

test("observeBindingQuota normalizes successful probe", async () => {
  const obs = await observeBindingQuota("b1", () => ({ exhausted: true }));
  assert.equal(obs.state, "EXHAUSTED");
});

test("missing observation -> UNKNOWN partition", () => {
  const b = binding({ binding_id: "b1", priority: 1 });
  const result = assessQuota([b], []);
  assert.deepEqual(
    result.unknown.map((x) => x.binding_id),
    ["b1"],
  );
  assert.deepEqual(result.available, []);
  assert.deepEqual(result.exhausted, []);
  assert.equal(result.observations[0]?.state, "UNKNOWN");
});

test("partitions preserve exact input order", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const c = binding({ binding_id: "c", priority: 3 });
  const d = binding({ binding_id: "d", priority: 4 });
  const result = assessQuota([a, b, c, d], [
    { binding_id: "d", state: "AVAILABLE" },
    { binding_id: "a", state: "EXHAUSTED" },
    { binding_id: "c", state: "AVAILABLE" },
    { binding_id: "b", state: "UNKNOWN" },
  ]);
  assert.deepEqual(
    result.available.map((x) => x.binding_id),
    ["c", "d"],
  );
  assert.deepEqual(
    result.exhausted.map((x) => x.binding_id),
    ["a"],
  );
  assert.deepEqual(
    result.unknown.map((x) => x.binding_id),
    ["b"],
  );
  assert.deepEqual(
    result.observations.map((x) => x.binding_id),
    ["a", "b", "c", "d"],
  );
});

test("observation insertion order does not alter partitions", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const bindings = [a, b];
  const forward = assessQuota(bindings, [
    { binding_id: "b", state: "AVAILABLE" },
    { binding_id: "a", state: "AVAILABLE" },
  ]);
  const reverse = assessQuota(bindings, [
    { binding_id: "a", state: "AVAILABLE" },
    { binding_id: "b", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    forward.available.map((x) => x.binding_id),
    ["a", "b"],
  );
  assert.deepEqual(
    reverse.available.map((x) => x.binding_id),
    ["a", "b"],
  );
});

test("duplicate binding_id observations are rejected", () => {
  const b1 = binding({ binding_id: "b1", priority: 1 });
  assert.throws(
    () =>
      assessQuota([b1], [
        { binding_id: "b1", state: "AVAILABLE" },
        { binding_id: "b1", state: "EXHAUSTED" },
      ]),
    (err: unknown) =>
      err instanceof RouterError &&
      err.code === "QUOTA_INVALID" &&
      /duplicate quota observation/.test(err.message),
  );
});

test("identical duplicate observations are also rejected", () => {
  const b1 = binding({ binding_id: "b1", priority: 1 });
  assert.throws(
    () =>
      assessQuota([b1], [
        { binding_id: "b1", state: "AVAILABLE" },
        { binding_id: "b1", state: "AVAILABLE" },
      ]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "QUOTA_INVALID",
  );
});

test("unrelated observations are ignored and cannot inject bindings", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = assessQuota([a], [
    { binding_id: "intruder", state: "AVAILABLE" },
    { binding_id: "a", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    result.available.map((x) => x.binding_id),
    ["a"],
  );
  assert.equal(result.available.length, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]?.binding_id, "a");
});

test("malformed non-boolean exhausted -> UNKNOWN", () => {
  const obs = normalizeQuota("b1", {
    exhausted: "yes" as unknown as boolean,
  });
  assert.equal(obs.state, "UNKNOWN");
});

test("relevant invalid normalized state -> QUOTA_INVALID", () => {
  const b = binding({ binding_id: "b1" });
  const bad = {
    binding_id: "b1",
    state: "CREDENTIAL_UNAVAILABLE",
  } as unknown as QuotaObservation;
  assert.throws(
    () => assessQuota([b], [bad]),
    (err: unknown) =>
      err instanceof RouterError && err.code === "QUOTA_INVALID",
  );
});

test("unrelated invalid state / duplicates ignored", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const result = assessQuota(
    [a],
    [
      {
        binding_id: "x",
        state: "CREDENTIAL_UNAVAILABLE",
      } as unknown as QuotaObservation,
      { binding_id: "x", state: "AVAILABLE" },
      { binding_id: "x", state: "EXHAUSTED" },
      { binding_id: "a", state: "AVAILABLE" },
    ],
  );
  assert.deepEqual(
    result.available.map((x) => x.binding_id),
    ["a"],
  );
  assert.equal(result.observations.length, 1);
});

test("assessQuota does not mutate input bindings", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const bindings = [a, b];
  const before = bindings.map((x) => x.binding_id);
  assessQuota(bindings, [
    { binding_id: "a", state: "EXHAUSTED" },
    { binding_id: "b", state: "AVAILABLE" },
  ]);
  assert.deepEqual(
    bindings.map((x) => x.binding_id),
    before,
  );
  assert.equal(bindings.length, 2);
});

test("provider_id/runtime_id/model_id do not affect quota state", () => {
  const obs = normalizeQuota("x", {
    exhausted: false,
    detail: "provider=cursor model=whatever",
  });
  assert.equal(obs.state, "AVAILABLE");
  const result = assessQuota(
    [
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
    ],
    [
      { binding_id: "y", state: "AVAILABLE" },
      { binding_id: "x", state: "AVAILABLE" },
    ],
  );
  assert.deepEqual(
    result.available.map((x) => x.binding_id),
    ["x", "y"],
  );
});

test("observations remain inspectable for later routing policy", () => {
  const a = binding({ binding_id: "a", priority: 1 });
  const b = binding({ binding_id: "b", priority: 2 });
  const result = assessQuota([a, b], [
    { binding_id: "a", state: "EXHAUSTED", detail: "plan cap" },
    { binding_id: "b", state: "UNKNOWN", detail: "no probe" },
  ] satisfies QuotaObservation[]);
  assert.equal(result.exhausted[0]?.binding_id, "a");
  assert.equal(result.unknown[0]?.binding_id, "b");
  assert.equal(result.observations[0]?.state, "EXHAUSTED");
  assert.equal(result.observations[1]?.state, "UNKNOWN");
});

test("quota module has no forbidden imports", () => {
  const text = readFileSync(
    join(repoRoot, "src", "router", "quota.ts"),
    "utf8",
  );
  const forbidden = [
    "execution/bindings",
    "reviewer/bindings",
    "program-control/bindings",
    "execution/model-policy",
    "control/db",
    "control/dispatcher",
    "control/routing",
    "execution/gateway",
    "reviewer/gateway",
    "program-control/gateway",
    "node:sqlite",
    "selectBinding",
    "overlayAvailability",
  ];
  for (const needle of forbidden) {
    assert.equal(text.includes(needle), false, `must not mention ${needle}`);
  }
});
