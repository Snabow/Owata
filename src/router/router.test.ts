import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Capability } from "../control/protocol.js";
import {
  PROVIDER_REGISTRY_PROTOCOL,
  RouterError,
  defaultProviderRegistryPath,
  filterEligibleBindings,
  loadProviderRegistry,
  parseProviderRegistry,
  parseProviderRegistryJson,
  type ProviderBinding,
  type ProviderRegistry,
} from "./index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const championPath = defaultProviderRegistryPath(repoRoot);

function binding(partial: Partial<ProviderBinding> & Pick<ProviderBinding, "binding_id">): ProviderBinding {
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

test("valid registry loads from object", () => {
  const reg = parseProviderRegistry({
    protocol: PROVIDER_REGISTRY_PROTOCOL,
    bindings: [
      {
        binding_id: "b1",
        role: "builder",
        provider_id: "p",
        runtime_id: "r",
        capabilities: ["repository_read"],
        priority: 1,
        enabled: true,
      },
    ],
  });
  assert.equal(reg.protocol, PROVIDER_REGISTRY_PROTOCOL);
  assert.equal(reg.bindings.length, 1);
  assert.equal(reg.bindings[0]?.binding_id, "b1");
});

test("unsupported registry version rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: "owata.provider-registry/0",
        bindings: [],
      }),
    (err: unknown) =>
      err instanceof RouterError && err.code === "REGISTRY_INVALID",
  );
});

test("duplicate binding_id rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "dup",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: 1,
            enabled: true,
          },
          {
            binding_id: "dup",
            role: "reviewer",
            provider_id: "p2",
            runtime_id: "r2",
            capabilities: [],
            priority: 2,
            enabled: true,
          },
        ],
      }),
    (err: unknown) =>
      err instanceof RouterError && /duplicate binding_id/.test(err.message),
  );
});

test("invalid role rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "x",
            role: "architect",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: 1,
            enabled: true,
          },
        ],
      }),
    RouterError,
  );
});

test("human role rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "h",
            role: "human",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: 1,
            enabled: true,
          },
        ],
      }),
    RouterError,
  );
});

test("dispatcher role rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "d",
            role: "dispatcher",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: 1,
            enabled: true,
          },
        ],
      }),
    RouterError,
  );
});

test("unknown capability rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "x",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: ["telepathy"],
            priority: 1,
            enabled: true,
          },
        ],
      }),
    RouterError,
  );
});

test("malformed priority rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "x",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: 1.5,
            enabled: true,
          },
        ],
      }),
    RouterError,
  );
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "x",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: "1",
            enabled: true,
          },
        ],
      }),
    RouterError,
  );
});

test("malformed enabled rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "x",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: 1,
            enabled: "true",
          },
        ],
      }),
    RouterError,
  );
});

test("duplicate capability rejected (canonical contract)", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "x",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: ["repository_read", "repository_read"],
            priority: 1,
            enabled: true,
          },
        ],
      }),
    (err: unknown) =>
      err instanceof RouterError && /duplicate capability/.test(err.message),
  );
});

test("unknown fields rejected", () => {
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [],
        extra: true,
      }),
    RouterError,
  );
  assert.throws(
    () =>
      parseProviderRegistry({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "x",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [],
            priority: 1,
            enabled: true,
            cost: 0,
          },
        ],
      }),
    RouterError,
  );
});

test("explicit path loader fails closed on missing file", () => {
  assert.throws(
    () => loadProviderRegistry(join(tmpdir(), "owata-missing-registry.json")),
    (err: unknown) =>
      err instanceof RouterError && err.code === "REGISTRY_UNREADABLE",
  );
});

test("explicit path loader fails closed on malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "owata-reg-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, "{not-json", "utf8");
  assert.throws(() => loadProviderRegistry(path), RouterError);
});

test("current champion config validates", () => {
  const reg = loadProviderRegistry(championPath);
  assert.equal(reg.protocol, PROVIDER_REGISTRY_PROTOCOL);
  assert.equal(reg.bindings.length, 3);
  const ids = reg.bindings.map((b) => b.binding_id).sort();
  assert.deepEqual(ids, [
    "codex-cli",
    "codex-cli-program-control",
    "cursor-cli",
  ]);
});

test("champion bindings represent current gateway capabilities as data", () => {
  const reg = loadProviderRegistry(championPath);
  const byId = new Map(reg.bindings.map((b) => [b.binding_id, b]));
  assert.equal(byId.get("cursor-cli")?.role, "builder");
  assert.deepEqual(byId.get("cursor-cli")?.capabilities, [
    "repository_read",
    "repository_write",
    "exact_checkout",
    "command_execution",
  ]);
  assert.equal(byId.get("codex-cli")?.role, "reviewer");
  assert.deepEqual(byId.get("codex-cli")?.capabilities, [
    "repository_read",
    "exact_checkout",
    "command_execution",
  ]);
  assert.equal(byId.get("codex-cli-program-control")?.role, "program_control");
  assert.deepEqual(byId.get("codex-cli-program-control")?.capabilities, [
    "repository_read",
  ]);
});

test("exact role match required", () => {
  const reg = registryOf(
    binding({ binding_id: "b", role: "builder", priority: 1 }),
    binding({
      binding_id: "r",
      role: "reviewer",
      priority: 1,
      capabilities: ["repository_read"],
    }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: [],
  });
  assert.equal(result.status, "ELIGIBLE");
  assert.deepEqual(
    result.bindings.map((b) => b.binding_id),
    ["b"],
  );
});

test("zero required capabilities returns all enabled bindings for role", () => {
  const reg = registryOf(
    binding({ binding_id: "b2", role: "builder", priority: 20 }),
    binding({ binding_id: "b1", role: "builder", priority: 10 }),
    binding({ binding_id: "off", role: "builder", priority: 1, enabled: false }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: [],
  });
  assert.equal(result.status, "ELIGIBLE");
  assert.deepEqual(
    result.bindings.map((b) => b.binding_id),
    ["b1", "b2"],
  );
});

test("one required capability filters correctly", () => {
  const reg = registryOf(
    binding({
      binding_id: "read-only",
      capabilities: ["repository_read"],
      priority: 1,
    }),
    binding({
      binding_id: "writer",
      capabilities: ["repository_read", "repository_write"],
      priority: 2,
    }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: ["repository_write"],
  });
  assert.deepEqual(
    result.bindings.map((b) => b.binding_id),
    ["writer"],
  );
});

test("multiple required capabilities require full superset", () => {
  const required: Capability[] = [
    "repository_read",
    "repository_write",
    "command_execution",
  ];
  const reg = registryOf(
    binding({
      binding_id: "partial",
      capabilities: ["repository_read", "repository_write"],
      priority: 1,
    }),
    binding({
      binding_id: "full",
      capabilities: [
        "repository_read",
        "repository_write",
        "command_execution",
        "network_access",
      ],
      priority: 2,
    }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: required,
  });
  assert.deepEqual(
    result.bindings.map((b) => b.binding_id),
    ["full"],
  );
});

test("disabled binding excluded", () => {
  const reg = registryOf(
    binding({ binding_id: "on", priority: 2, enabled: true }),
    binding({ binding_id: "off", priority: 1, enabled: false }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: [],
  });
  assert.deepEqual(
    result.bindings.map((b) => b.binding_id),
    ["on"],
  );
});

test("wrong-role binding excluded", () => {
  const reg = registryOf(
    binding({ binding_id: "pc", role: "program_control", priority: 1 }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: [],
  });
  assert.equal(result.status, "NO_ELIGIBLE_BINDING");
  assert.deepEqual(result.bindings, []);
});

test("no eligible binding returns NO_ELIGIBLE_BINDING with empty bindings", () => {
  const reg = registryOf(
    binding({
      binding_id: "b",
      capabilities: ["repository_read"],
      priority: 1,
    }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: ["network_access"],
  });
  assert.equal(result.status, "NO_ELIGIBLE_BINDING");
  assert.deepEqual(result.bindings, []);
});

test("deterministic ordering: priority ASC then binding_id ASC", () => {
  const reg = registryOf(
    binding({ binding_id: "z", priority: 1, provider_id: "zzz" }),
    binding({ binding_id: "a", priority: 1, provider_id: "aaa" }),
    binding({ binding_id: "m", priority: 0, provider_id: "mmm" }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: [],
  });
  assert.deepEqual(
    result.bindings.map((b) => b.binding_id),
    ["m", "a", "z"],
  );
});

test("order independent from config insertion order", () => {
  const forward = filterEligibleBindings(
    registryOf(
      binding({ binding_id: "b", priority: 5 }),
      binding({ binding_id: "a", priority: 5 }),
    ),
    { role: "builder", requiredCapabilities: [] },
  );
  const reverse = filterEligibleBindings(
    registryOf(
      binding({ binding_id: "a", priority: 5 }),
      binding({ binding_id: "b", priority: 5 }),
    ),
    { role: "builder", requiredCapabilities: [] },
  );
  assert.deepEqual(
    forward.bindings.map((b) => b.binding_id),
    ["a", "b"],
  );
  assert.deepEqual(
    reverse.bindings.map((b) => b.binding_id),
    ["a", "b"],
  );
});

test("provider_id and model_id do not affect ordering", () => {
  const reg = registryOf(
    binding({
      binding_id: "b",
      priority: 1,
      provider_id: "aaa",
      model_id: "model-aaa",
    }),
    binding({
      binding_id: "a",
      priority: 1,
      provider_id: "zzz",
      model_id: "model-zzz",
    }),
  );
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: [],
  });
  assert.deepEqual(
    result.bindings.map((b) => b.binding_id),
    ["a", "b"],
  );
});

test("generic fixture provider/runtime IDs work without Champion branches", () => {
  const reg = parseProviderRegistry({
    protocol: PROVIDER_REGISTRY_PROTOCOL,
    bindings: [
      {
        binding_id: "fixture-alpha",
        role: "builder",
        provider_id: "acme-cloud",
        runtime_id: "acme-runtime-1",
        model_id: "acme-model-x",
        capabilities: ["repository_read", "command_execution"],
        priority: 7,
        enabled: true,
      },
    ],
  });
  const result = filterEligibleBindings(reg, {
    role: "builder",
    requiredCapabilities: ["command_execution"],
  });
  assert.equal(result.status, "ELIGIBLE");
  assert.equal(result.bindings[0]?.provider_id, "acme-cloud");
  assert.equal(result.bindings[0]?.runtime_id, "acme-runtime-1");
});

test("router module source has no forbidden imports", () => {
  const routerDir = join(repoRoot, "src", "router");
  const files = [
    "index.ts",
    "types.ts",
    "registry.ts",
    "eligibility.ts",
  ];
  const forbidden = [
    "program-control/gateway",
    "reviewer/gateway",
    "execution/gateway",
    "execution/model-policy",
    "control/db",
    "ControlStore",
    "HandoffStore",
    "node:sqlite",
  ];
  for (const file of files) {
    const text = readFileSync(join(routerDir, file), "utf8");
    for (const needle of forbidden) {
      assert.equal(
        text.includes(needle),
        false,
        `${file} must not mention ${needle}`,
      );
    }
  }
});

test("parseProviderRegistryJson round-trip for champion file text", () => {
  const text = readFileSync(championPath, "utf8");
  const reg = parseProviderRegistryJson(text);
  assert.equal(reg.bindings.length, 3);
});
