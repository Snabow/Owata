import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ControlError, ControlStore, Dispatcher, HandoffStore } from "./index.js";
import {
  catalogByBindingId,
  isFailoverEligiblePrior,
  parseFailoverPolicy,
  resolvePinnedBinding,
  sanitizeRoutingObservations,
  selectFailoverBinding,
  selectRoutedBinding,
  validateRuntimeCatalog,
  type AvailabilityProbeFn,
  type CostProbeFn,
  type RuntimeCatalogEntry,
} from "./routing.js";
import {
  FakeBuilderAdapter,
  FakeProgramControlAdapter,
  FakeReviewerAdapter,
} from "./fixtures/fake-adapters.js";
import { PROTOCOL_V1, type PcDecisionBody } from "./protocol.js";
import {
  PROVIDER_REGISTRY_PROTOCOL,
  parseProviderRegistryJson,
  type CostRoutingConstraint,
  type ProviderRegistry,
} from "../router/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Shared live cost ceiling for S5/S9 fixtures under S11 cutover (A-026). */
const TEST_COST_CONSTRAINT: CostRoutingConstraint = {
  max_estimate: { amount_decimal: "100", currency_code: "USD" },
};

function costWithin(amount = "1"): CostProbeFn {
  return () => ({
    estimate: { amount_decimal: amount, currency_code: "USD" },
  });
}

function costOver(): CostProbeFn {
  return () => ({
    estimate: { amount_decimal: "101", currency_code: "USD" },
  });
}

function costMismatch(): CostProbeFn {
  return () => ({
    estimate: { amount_decimal: "1", currency_code: "EUR" },
  });
}

function costMalformed(): CostProbeFn {
  return () =>
    ({ estimate: { amount_decimal: "nope", currency_code: "usd" } }) as never;
}

function costThrows(): CostProbeFn {
  return () => {
    throw new Error("cost probe boom");
  };
}

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "owata-wp004-s5-"));
}

function cleanup(dir: string): void {
  for (let i = 0; i < 12; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
}

function seqIds(): (prefix?: string) => string {
  let n = 0;
  return (prefix?: string) => `${prefix ?? "id"}_${++n}`;
}

function openHarness(dir: string) {
  const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
  const handoff = new HandoffStore(store);
  const envClock = {
    id: (prefix?: string) => store.nextId(prefix),
    now: () => store.now().toISOString(),
  };
  return { store, handoff, envClock };
}

function pcDecision(
  partial: Partial<PcDecisionBody> & Pick<PcDecisionBody, "decision">,
): PcDecisionBody {
  return {
    rationale: null,
    authorized_finding_ids: [],
    rework_scope: null,
    human_gate_purpose: null,
    human_gate_choices: null,
    install_policy: null,
    ...partial,
  };
}

const BUILD_CAPS = [
  "repository_read",
  "repository_write",
  "exact_checkout",
  "command_execution",
] as const;

const REVIEW_CAPS = [
  "repository_read",
  "exact_checkout",
  "command_execution",
] as const;

function multiBuilderRegistry(): ProviderRegistry {
  return parseProviderRegistryJson(
    JSON.stringify({
      protocol: PROVIDER_REGISTRY_PROTOCOL,
      bindings: [
        {
          binding_id: "builder-a",
          role: "builder",
          provider_id: "prov-a",
          runtime_id: "rt-a",
          capabilities: [...BUILD_CAPS],
          priority: 10,
          enabled: true,
        },
        {
          binding_id: "builder-b",
          role: "builder",
          provider_id: "prov-b",
          runtime_id: "rt-b",
          capabilities: [...BUILD_CAPS],
          priority: 20,
          enabled: true,
        },
        {
          binding_id: "pc-main",
          role: "program_control",
          provider_id: "prov-pc",
          runtime_id: "rt-pc",
          capabilities: ["repository_read"],
          priority: 10,
          enabled: true,
        },
        {
          binding_id: "reviewer-main",
          role: "reviewer",
          provider_id: "prov-rev",
          runtime_id: "rt-rev",
          capabilities: [...REVIEW_CAPS],
          priority: 10,
          enabled: true,
        },
      ],
    }),
  );
}

function available(): AvailabilityProbeFn {
  return () => ({ ok: true, authReady: true });
}

function unavailable(
  kind: "cred" | "agent",
  detail?: string,
): AvailabilityProbeFn {
  if (kind === "cred") {
    return () => ({ ok: true, authReady: false, detail });
  }
  return () => ({ ok: false, authReady: false, detail });
}

test("validateRuntimeCatalog fail-closed cases", () => {
  const registry = multiBuilderRegistry();
  const pc = new FakeProgramControlAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  const builder = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });

  assert.throws(
    () =>
      validateRuntimeCatalog(registry, [
        {
          binding_id: "",
          role: "builder",
          adapter: builder,
          probe: available(),
        costProbe: costWithin(),
        },
      ]),
    (err: unknown) =>
      err instanceof ControlError && err.code === "ROUTING_CONFIG_INVALID",
  );

  assert.throws(
    () =>
      validateRuntimeCatalog(registry, [
        {
          binding_id: "builder-a",
          role: "builder",
          adapter: builder,
          probe: available(),
        costProbe: costWithin(),
        },
        {
          binding_id: "builder-a",
          role: "builder",
          adapter: builder,
          probe: available(),
        costProbe: costWithin(),
        },
      ]),
    /duplicate/,
  );

  assert.throws(
    () =>
      validateRuntimeCatalog(registry, [
        {
          binding_id: "builder-a",
          role: "builder",
          adapter: pc as unknown as typeof builder,
          probe: available(),
        costProbe: costWithin(),
        },
      ]),
    /adapter\.identity\.role/,
  );

  assert.throws(
    () =>
      validateRuntimeCatalog(registry, [
        {
          binding_id: "not-in-registry",
          role: "builder",
          adapter: builder,
          probe: available(),
        costProbe: costWithin(),
        },
      ]),
    /absent from ProviderRegistry/,
  );

  const mismatched = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  mismatched.identity = { adapter_id: "fake-builder", role: "builder" };
  assert.throws(
    () =>
      validateRuntimeCatalog(registry, [
        {
          binding_id: "pc-main",
          role: "program_control",
          adapter: mismatched as unknown as FakeProgramControlAdapter,
          probe: available(),
        costProbe: costWithin(),
        },
      ]),
    (err: unknown) =>
      err instanceof ControlError && err.code === "ROUTING_CONFIG_INVALID",
  );
});

test("missing registry binding without catalog entry is UNKNOWN; cannot select", async () => {
  const registry = multiBuilderRegistry();
  const builderB = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  // Catalog only for builder-b; builder-a eligible but UNKNOWN
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  // builder-a is higher priority but UNKNOWN → skip; builder-b AVAILABLE → SELECTED
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-b");
  }
  assert.ok(
    outcome.observations.some(
      (o) => o.binding_id === "builder-a" && o.state === "UNKNOWN",
    ),
  );

  const onlyUnknown = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(onlyUnknown.status, "BLOCKED");
  if (onlyUnknown.status === "BLOCKED") {
    assert.equal(onlyUnknown.reason, "NO_AVAILABLE_BINDING");
    assert.ok(
      onlyUnknown.observations.every((o) => o.state === "UNKNOWN"),
    );
  }
});

test("sanitizeRoutingObservations strips raw probe detail", () => {
  const cleaned = sanitizeRoutingObservations([
    {
      binding_id: "x",
      state: "CREDENTIAL_UNAVAILABLE",
      detail: "secret token path /home/user/.creds",
    },
  ]);
  assert.deepEqual(cleaned, [
    { binding_id: "x", state: "CREDENTIAL_UNAVAILABLE" },
  ]);
  assert.equal("detail" in cleaned[0]!, false);
});

test("routing disabled preserves legacy fixed Dispatcher adapters", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s5-legacy");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-legacy" }],
      envClock,
    );
    builder.identity = { adapter_id: "fake-builder", role: "builder" };
    const reviewer = new FakeReviewerAdapter([], envClock);
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      { owner: "disp", leaseMs: 60_000 },
    );
    assert.equal(dispatcher.options.routing, undefined);
    let last = await dispatcher.step(cycle.cycle_id);
    while (
      last.cycle.state === "AWAITING_PC" ||
      last.cycle.state === "DISPATCHING_PC" ||
      last.cycle.state === "DISPATCHING_BUILD"
    ) {
      last = await dispatcher.step(cycle.cycle_id);
      if (builder.invocations >= 1 && last.cycle.state === "AWAITING_PC") {
        break;
      }
      if (last.cycle.state === "RECOVERY_REQUIRED" || last.cycle.state === "ABORTED") {
        break;
      }
    }
    assert.equal(pc.invocations, 1);
    assert.equal(builder.invocations, 1);
    assert.equal(last.cycle.state, "AWAITING_PC");
    const rows = handoff.store.db
      .prepare(`SELECT binding_id FROM dispatches`)
      .all() as Array<{ binding_id: string | null }>;
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => r.binding_id == null));
  } finally {
    cleanup(dir);
  }
});
test("routing enabled uses catalog adapter, not legacy fixed fallback", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s5-cutover");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 3,
    });

    const legacyPc = new FakeProgramControlAdapter([], envClock);
    legacyPc.identity = {
      adapter_id: "legacy-pc",
      role: "program_control",
    };
    const catalogPc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    catalogPc.identity = {
      adapter_id: "catalog-pc",
      role: "program_control",
    };

    const legacyBuilder = new FakeBuilderAdapter([], envClock);
    legacyBuilder.identity = { adapter_id: "legacy-builder", role: "builder" };
    const catalogBuilder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-1" }],
      envClock,
    );
    catalogBuilder.identity = {
      adapter_id: "fake-builder",
      role: "builder",
    };

    const legacyReviewer = new FakeReviewerAdapter([], envClock);
    legacyReviewer.identity = {
      adapter_id: "legacy-reviewer",
      role: "reviewer",
    };
    const catalogReviewer = new FakeReviewerAdapter([], envClock);
    catalogReviewer.identity = {
      adapter_id: "catalog-reviewer",
      role: "reviewer",
    };

    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: catalogPc,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: catalogBuilder,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: catalogReviewer,
        probe: available(),
      costProbe: costWithin(),
      },
    ];

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: legacyPc,
        builder: legacyBuilder,
        reviewer: legacyReviewer,
      },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );

    const last = await (async () => {
      let step = await dispatcher.step(cycle.cycle_id);
      for (let i = 0; i < 24; i += 1) {
        if (
          catalogBuilder.invocations >= 1 &&
          step.cycle.state === "AWAITING_PC"
        ) {
          return step;
        }
        if (
          step.cycle.state === "RECOVERY_REQUIRED" ||
          step.cycle.state === "ABORTED" ||
          step.cycle.state === "ACCEPTED"
        ) {
          return step;
        }
        step = await dispatcher.step(cycle.cycle_id);
      }
      return step;
    })();
    assert.equal(legacyPc.invocations, 0);
    assert.equal(catalogPc.invocations, 1);
    assert.equal(legacyBuilder.invocations, 0);
    assert.equal(catalogBuilder.invocations, 1);
    assert.equal(last.cycle.state, "AWAITING_PC");

    const claimed = handoff.store
      .listEvents()
      .filter((e) => e.event_type === "cycle.dispatch_claimed");
    const rows = handoff.store.db
      .prepare(
        `SELECT target_role, binding_id FROM dispatches ORDER BY attempt_number, dispatch_id`,
      )
      .all() as Array<{ target_role: string; binding_id: string }>;
    const pcRow = rows.find((r) => r.target_role === "program_control");
    const buildRow = rows.find((r) => r.target_role === "builder");
    assert.equal(pcRow?.binding_id, "pc-main");
    assert.equal(buildRow?.binding_id, "builder-a");
    assert.ok(claimed.length >= 2);
    assert.notEqual(
      catalogBuilder.identity.adapter_id,
      buildRow?.binding_id,
    );
  } finally {
    cleanup(dir);
  }
});

test("S3 order: unavailable higher priority skipped on initial select; pin blocks failover", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s5-pin");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 3,
    });

    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    pc.identity = { adapter_id: "catalog-pc", role: "program_control" };

    let aProbe: AvailabilityProbeFn = available();
    const builderA = new FakeBuilderAdapter(
      [
        {
          status: "FAILED",
          notes: "intentional fail for pin test",
        },
      ],
      envClock,
    );
    // Force runtime throw on second attempt path after first result accepted as FAILED → AWAITING_PC
    // Better: throw on build so dispatch is REJECTED and same request retries.
    let aCalls = 0;
    const origBuild = builderA.build.bind(builderA);
    builderA.build = (input) => {
      aCalls += 1;
      if (aCalls === 1) {
        throw new Error("builder-a boom");
      }
      return origBuild(input);
    };
    builderA.identity = { adapter_id: "fake-builder", role: "builder" };

    const builderB = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-b" }],
      envClock,
    );
    builderB.identity = { adapter_id: "fake-builder", role: "builder" };

    const reviewer = new FakeReviewerAdapter([], envClock);
    reviewer.identity = {
      adapter_id: "catalog-reviewer",
      role: "reviewer",
    };

    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: () => aProbe(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
      costProbe: costWithin(),
      },
    ];

    const dispatcher = new Dispatcher(
      handoff,
      {
        programControl: pc,
        builder: builderA,
        reviewer,
      },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );

    // Drive until builder first attempt fails
    let last = await dispatcher.step(cycle.cycle_id); // PC setup/dispatch
    while (
      last.cycle.state === "DISPATCHING_PC" ||
      last.action === "pc_decision" ||
      (last.cycle.state === "DISPATCHING_BUILD" && aCalls === 0)
    ) {
      last = await dispatcher.step(cycle.cycle_id);
      if (last.action === "runtime_error") break;
      if (aCalls > 0 && last.action !== "pc_decision") break;
    }
    assert.equal(aCalls, 1);
    assert.equal(builderB.invocations, 0);

    const firstBuild = handoff
      .store.db.prepare(
        `SELECT binding_id, state FROM dispatches WHERE target_role = 'builder' ORDER BY attempt_number`,
      )
      .all() as Array<{ binding_id: string; state: string }>;
    assert.equal(firstBuild[0]?.binding_id, "builder-a");
    assert.equal(firstBuild[0]?.state, "REJECTED");

    // Make A unavailable; B still available — pin must NOT switch to B
    aProbe = unavailable("agent", "raw agent down detail");
    last = await dispatcher.step(cycle.cycle_id);
    assert.equal(last.action, "routing_blocked");
    assert.equal(last.cycle.state, "RECOVERY_REQUIRED");
    assert.equal(builderB.invocations, 0);
    assert.equal(aCalls, 1);

    const block = handoff.store
      .listEvents()
      .find((e) => e.event_type === "cycle.routing_blocked");
    assert.ok(block);
    const payload = block!.payload as {
      router_status: string;
      pinned_binding_id: string;
      observations: Array<{ binding_id: string; state: string; detail?: string }>;
    };
    assert.equal(payload.router_status, "PINNED_BINDING_UNAVAILABLE");
    assert.equal(payload.pinned_binding_id, "builder-a");
    assert.equal(payload.observations[0]?.state, "AGENT_UNAVAILABLE");
    assert.equal(payload.observations[0]?.detail, undefined);

    // No new dispatch fabricated for the block
    const builds = handoff
      .store.db.prepare(
        `SELECT COUNT(*) AS n FROM dispatches WHERE target_role = 'builder'`,
      )
      .get() as { n: number };
    assert.equal(Number(builds.n), 1);
  } finally {
    cleanup(dir);
  }
});

test("null binding_id provenance fails closed in routed mode", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s5-prov");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 3,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha" }],
      envClock,
    );
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builder,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
      costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );

    // Run PC → BUILD request persisted
    let last = await dispatcher.step(cycle.cycle_id);
    while (last.cycle.state !== "DISPATCHING_BUILD") {
      last = await dispatcher.step(cycle.cycle_id);
      if (last.cycle.state === "RECOVERY_REQUIRED") break;
    }
    assert.equal(last.cycle.state, "DISPATCHING_BUILD");
    const reqId = last.cycle.current_request_id!;

    // Inject legacy unattributed dispatch for this request
    handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId,
      targetRole: "builder",
      owner: "other",
      leaseMs: 1,
      bindingId: null,
    });
    // Expire it so invokeRole will try a new claim path with latest NULL provenance
    store.db
      .prepare(
        `UPDATE dispatches SET state = 'EXPIRED', lease_expires_at = ? WHERE request_id = ?`,
      )
      .run(new Date(0).toISOString(), reqId);

    last = await dispatcher.step(cycle.cycle_id);
    assert.equal(last.action, "routing_blocked");
    assert.equal(
      (last.detail as { reason: string }).reason,
      "ROUTING_PROVENANCE_MISSING",
    );
    assert.equal(builder.invocations, 0);
  } finally {
    cleanup(dir);
  }
});

test("NO_ELIGIBLE_BINDING / NO_AVAILABLE_BINDING: no dispatch, recovery, preserved states", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s5-block");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });

    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    // Builder lacks capabilities → NO_ELIGIBLE after PC selects BUILD with DEFAULT_BUILD_CAPS
    const weakBuilder = new FakeBuilderAdapter([], envClock, ["repository_read"]);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = parseProviderRegistryJson(
      JSON.stringify({
        protocol: PROVIDER_REGISTRY_PROTOCOL,
        bindings: [
          {
            binding_id: "pc-main",
            role: "program_control",
            provider_id: "p",
            runtime_id: "r",
            capabilities: ["repository_read"],
            priority: 1,
            enabled: true,
          },
          {
            binding_id: "builder-weak",
            role: "builder",
            provider_id: "p",
            runtime_id: "r",
            capabilities: ["repository_read"],
            priority: 1,
            enabled: true,
          },
          {
            binding_id: "reviewer-main",
            role: "reviewer",
            provider_id: "p",
            runtime_id: "r",
            capabilities: [...REVIEW_CAPS],
            priority: 1,
            enabled: true,
          },
        ],
      }),
    );
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "builder-weak",
        role: "builder",
        adapter: weakBuilder,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
      costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: weakBuilder, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );

    let last = await dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(last.action, "routing_blocked");
    assert.equal(last.cycle.state, "RECOVERY_REQUIRED");
    assert.equal(
      (last.detail as { reason: string }).reason,
      "NO_ELIGIBLE_BINDING",
    );
    const buildCount = handoff
      .store.db.prepare(
        `SELECT COUNT(*) AS n FROM dispatches WHERE target_role = 'builder'`,
      )
      .get() as { n: number };
    assert.equal(Number(buildCount.n), 0);

    const block = handoff.store
      .listEvents()
      .find((e) => e.event_type === "cycle.routing_blocked");
    assert.equal(
      (block?.payload as { router_status: string }).router_status,
      "NO_ELIGIBLE_BINDING",
    );
  } finally {
    cleanup(dir);
  }
});

test("NO_AVAILABLE_BINDING preserves CREDENTIAL / AGENT / UNKNOWN without raw detail", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  const builderB = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: unavailable("cred", "secret-cred-path"),
      costProbe: costWithin(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: unavailable("agent", "secret-agent-msg"),
      costProbe: costWithin(),
    },
  ]);
  // Also include an eligible registry binding without catalog → UNKNOWN
  // (builder-a/b covered; add nothing else)

  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "BLOCKED");
  if (outcome.status === "BLOCKED") {
    assert.equal(outcome.reason, "NO_AVAILABLE_BINDING");
    const states = outcome.observations.map((o) => o.state).sort();
    assert.deepEqual(states, [
      "AGENT_UNAVAILABLE",
      "CREDENTIAL_UNAVAILABLE",
    ]);
    const durable = sanitizeRoutingObservations(outcome.observations);
    assert.ok(durable.every((o) => !("detail" in o && o.detail)));
    assert.ok(
      outcome.observations.some((o) => o.detail !== undefined),
      "raw detail may exist ephemerally",
    );
  }
});

test("pinned binding resolve does not select alternate available binding", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  const builderB = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: unavailable("agent"),
      costProbe: costWithin(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
    },
  ]);
  const pinned = await resolvePinnedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    pinnedBindingId: "builder-a",
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(pinned.status, "BLOCKED");
  if (pinned.status === "BLOCKED") {
    assert.equal(pinned.reason, "PINNED_BINDING_UNAVAILABLE");
    assert.equal(pinned.pinned_binding_id, "builder-a");
  }
});

test("new request_id may reselect independently (semantic boundary)", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  const builderB = new FakeBuilderAdapter([], {
    id: () => "x",
    now: () => "t",
  });
  let aOk = true;
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: () =>
        aOk
          ? { ok: true, authReady: true }
          : { ok: false, authReady: false },
      costProbe: costWithin(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
    },
  ]);
  const first = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(first.status, "SELECTED");
  if (first.status === "SELECTED") {
    assert.equal(first.binding_id, "builder-a");
  }
  aOk = false;
  const second = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(second.status, "SELECTED");
  if (second.status === "SELECTED") {
    assert.equal(second.binding_id, "builder-b");
  }
});

test("canary wiring references current registry binding ids", () => {
  const registryPath = join(repoRoot, "config", "provider-registry.json");
  const registry = parseProviderRegistryJson(readFileSync(registryPath, "utf8"));
  const ids = new Set(registry.bindings.map((b) => b.binding_id));
  assert.ok(ids.has("codex-cli-program-control"));
  assert.ok(ids.has("cursor-cli"));
  assert.ok(ids.has("codex-cli"));

  const canarySrc = readFileSync(
    join(repoRoot, "src", "canary", "b2-full-no-relay-canary.ts"),
    "utf8",
  );
  assert.match(canarySrc, /loadProviderRegistry/);
  assert.match(canarySrc, /defaultProviderRegistryPath/);
  assert.match(canarySrc, /routing:\s*\{/);
  // Legacy canary intentionally omits costConstraint (compile-time optional;
  // active routed runtime still fail-closed). Must not invent monetary values.
  assert.doesNotMatch(canarySrc, /costConstraint/);
  assert.doesNotMatch(canarySrc, /999999/);
  assert.doesNotMatch(canarySrc, /amount_decimal:\s*"0"/);
  assert.match(canarySrc, /pcBinding\.bindingId/);
  assert.match(canarySrc, /builderBinding\.bindingId/);
  assert.match(canarySrc, /reviewerBinding\.bindingId/);
});

test("Dispatcher constructor fail-closed on invalid catalog", () => {
  const dir = tempState();
  try {
    const { handoff, envClock } = openHarness(dir);
    const pc = new FakeProgramControlAdapter([], envClock);
    const builder = new FakeBuilderAdapter([], envClock);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    assert.throws(
      () =>
        new Dispatcher(
          handoff,
          { programControl: pc, builder, reviewer },
          {
            owner: "disp",
            leaseMs: 60_000,
            routing: {
              registry,
              costConstraint: TEST_COST_CONSTRAINT,
              catalog: [
                {
                  binding_id: "builder-a",
                  role: "builder",
                  adapter: builder,
                  probe: available(),
                  costProbe: costWithin(),
                },
                {
                  binding_id: "builder-a",
                  role: "builder",
                  adapter: builder,
                  probe: available(),
                  costProbe: costWithin(),
                },
              ],
            },
          },
        ),
      (err: unknown) =>
        err instanceof ControlError && err.code === "ROUTING_CONFIG_INVALID",
    );
  } finally {
    cleanup(dir);
  }
});

test("reviewer routed selection attributes codex-cli-style binding_id", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s5-rev");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "DISPATCH_REVIEW" },
        }),
        pcDecision({ decision: "ACCEPT", rationale: "ok" }),
      ],
      envClock,
    );
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-r" }],
      envClock,
    );
    const reviewer = new FakeReviewerAdapter([{ verdict: "PASS" }], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builder,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
      costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );
    const last = await dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(reviewer.invocations, 1);
    const revRow = handoff.store.db
      .prepare(
        `SELECT binding_id FROM dispatches WHERE target_role = 'reviewer'`,
      )
      .get() as { binding_id: string } | undefined;
    assert.equal(revRow?.binding_id, "reviewer-main");
    assert.notEqual(reviewer.identity.adapter_id, "reviewer-main");
    assert.ok(
      last.cycle.state === "ACCEPTED" ||
        last.cycle.state === "AWAITING_PC" ||
        last.cycle.state === "DISPATCHING_PC" ||
        last.cycle.state === "HUMAN_GATE",
    );
    if (
      last.cycle.state === "AWAITING_PC" ||
      last.cycle.state === "DISPATCHING_PC"
    ) {
      const done = await dispatcher.runUntilStable(cycle.cycle_id);
      assert.equal(done.cycle.state, "ACCEPTED");
    }
  } finally {
    cleanup(dir);
  }
});

function quotaAvailable(): import("./routing.js").QuotaProbeFn {
  return () => ({ exhausted: false });
}

function quotaExhausted(): import("./routing.js").QuotaProbeFn {
  return () => ({ exhausted: true });
}

function quotaMalformed(): import("./routing.js").QuotaProbeFn {
  return () => ({ exhausted: "yes" as unknown as boolean });
}

function quotaThrows(): import("./routing.js").QuotaProbeFn {
  return () => {
    throw new Error("quota probe boom");
  };
}

test("S9: no quotaProbe preserves S5 selected binding (UNKNOWN fallback)", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-a");
    assert.equal(outcome.quota_state, "UNKNOWN");
  }
});

test("S9: higher-priority UNKNOWN + lower-priority AVAILABLE → AVAILABLE", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  let probedB = false;
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: () => {
        probedB = true;
        return { exhausted: false };
      },
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-b");
    assert.equal(outcome.quota_state, "AVAILABLE");
  }
  assert.equal(probedB, true);
});

test("S9: higher-priority EXHAUSTED + lower-priority UNKNOWN → UNKNOWN", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaExhausted(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-b");
    assert.equal(outcome.quota_state, "UNKNOWN");
  }
});

test("S9: higher-priority EXHAUSTED + lower-priority AVAILABLE → AVAILABLE", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaExhausted(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-b");
    assert.equal(outcome.quota_state, "AVAILABLE");
  }
});

test("S9: all available candidates EXHAUSTED → NO_QUOTA_ROUTABLE_BINDING", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaExhausted(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaExhausted(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "BLOCKED");
  if (outcome.status === "BLOCKED") {
    assert.equal(outcome.reason, "NO_QUOTA_ROUTABLE_BINDING");
    assert.equal(outcome.quota_observations.length, 2);
  }
});

test("S9: quota probe exception / malformed → UNKNOWN fallback", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const throwOutcome = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaThrows(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(throwOutcome.status, "SELECTED");
  if (throwOutcome.status === "SELECTED") {
    assert.equal(throwOutcome.binding_id, "builder-a");
    assert.equal(throwOutcome.quota_state, "UNKNOWN");
  }

  const badOutcome = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaMalformed(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(badOutcome.status, "SELECTED");
  if (badOutcome.status === "SELECTED") {
    assert.equal(badOutcome.binding_id, "builder-b");
    assert.equal(badOutcome.quota_state, "UNKNOWN");
  }
});

test("S9: availability-unavailable binding quotaProbe is not invoked", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  let aQuota = 0;
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: unavailable("agent"),
      costProbe: costWithin(),
      quotaProbe: () => {
        aQuota += 1;
        return { exhausted: false };
      },
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-b");
  }
  assert.equal(aQuota, 0);
});

test("S9: pinned AVAILABLE / UNKNOWN remain pinned; EXHAUSTED blocks without alternate", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const base = {
    registry,
    request: {
      role: "builder" as const,
      requiredCapabilities: [...BUILD_CAPS],
    },
    pinnedBindingId: "builder-a",
  };

  const avail = await resolvePinnedBinding({
    ...base,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
    ]),
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(avail.status, "SELECTED");
  if (avail.status === "SELECTED") {
    assert.equal(avail.binding_id, "builder-a");
    assert.equal(avail.quota_state, "AVAILABLE");
  }

  const unknown = await resolvePinnedBinding({
    ...base,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
    ]),
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(unknown.status, "SELECTED");
  if (unknown.status === "SELECTED") {
    assert.equal(unknown.binding_id, "builder-a");
    assert.equal(unknown.quota_state, "UNKNOWN");
  }

  const exhausted = await resolvePinnedBinding({
    ...base,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaExhausted(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
    ]),
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(exhausted.status, "BLOCKED");
  if (exhausted.status === "BLOCKED") {
    assert.equal(exhausted.reason, "PINNED_BINDING_QUOTA_EXHAUSTED");
    assert.equal(exhausted.pinned_binding_id, "builder-a");
  }
});

test("S9: sanitizeQuotaRoutingObservations strips raw detail", async () => {
  const { sanitizeQuotaRoutingObservations } = await import("./routing.js");
  const cleaned = sanitizeQuotaRoutingObservations([
    {
      binding_id: "x",
      state: "UNKNOWN",
      detail: "secret remaining_tokens=99",
    },
  ]);
  assert.deepEqual(cleaned, [{ binding_id: "x", state: "UNKNOWN" }]);
  assert.equal("detail" in cleaned[0]!, false);
});

test("S9: NO_QUOTA_ROUTABLE_BINDING enters recovery with sanitized quota evidence; no dispatch", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s9-quota-block");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          authorized_finding_ids: [],
          install_policy: null,
        }),
      ],
      envClock,
    );
    const builderA = new FakeBuilderAdapter([], envClock);
    const builderB = new FakeBuilderAdapter([], envClock);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
      costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaExhausted(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaExhausted(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
      costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      { owner: "disp", leaseMs: 60_000, routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT } },
    );
    const last = await dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(last.action, "routing_blocked");
    assert.equal(builderA.invocations, 0);
    assert.equal(builderB.invocations, 0);
    const block = handoff.store
      .listEvents()
      .find((e) => e.event_type === "cycle.routing_blocked");
    assert.ok(block);
    const payload = block!.payload as {
      router_status: string;
      quota_observations: {
        binding_id: string;
        state: string;
        detail?: string;
      }[];
    };
    assert.equal(payload.router_status, "NO_QUOTA_ROUTABLE_BINDING");
    assert.ok(Array.isArray(payload.quota_observations));
    assert.ok(
      payload.quota_observations.every(
        (o) => o.state === "EXHAUSTED" && !("detail" in o && o.detail),
      ),
    );
    const dispatchCount = (
      handoff.store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM dispatches WHERE target_role = 'builder'`,
        )
        .get() as { c: number }
    ).c;
    assert.equal(dispatchCount, 0);
  } finally {
    cleanup(dir);
  }
});

test("S11: missing/malformed costConstraint → ROUTING_CONFIG_INVALID", () => {
  const dir = tempState();
  try {
    const { handoff, envClock } = openHarness(dir);
    const pc = new FakeProgramControlAdapter([], envClock);
    const builder = new FakeBuilderAdapter([], envClock);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builder,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    assert.throws(
      () =>
        new Dispatcher(
          handoff,
          { programControl: pc, builder, reviewer },
          {
            owner: "disp",
            leaseMs: 60_000,
            routing: {
              registry,
              catalog,
              costConstraint: undefined as unknown as typeof TEST_COST_CONSTRAINT,
            },
          },
        ),
      (err: unknown) =>
        err instanceof ControlError && err.code === "ROUTING_CONFIG_INVALID",
    );
    assert.throws(
      () =>
        new Dispatcher(
          handoff,
          { programControl: pc, builder, reviewer },
          {
            owner: "disp",
            leaseMs: 60_000,
            routing: {
              registry,
              catalog,
              costConstraint: {
                max_estimate: {
                  amount_decimal: "1.2.3",
                  currency_code: "USD",
                },
              },
            },
          },
        ),
      (err: unknown) =>
        err instanceof ControlError && err.code === "ROUTING_CONFIG_INVALID",
    );
  } finally {
    cleanup(dir);
  }
});

test("S11: missing costProbe / exception / malformed → NO_COST_VERIFIABLE_BINDING", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const missing = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(missing.status, "BLOCKED");
  if (missing.status === "BLOCKED") {
    assert.equal(missing.reason, "NO_COST_VERIFIABLE_BINDING");
    assert.equal(missing.cost_observations[0]?.state, "UNKNOWN");
  }

  const thrown = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costThrows(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(thrown.status, "BLOCKED");
  if (thrown.status === "BLOCKED") {
    assert.equal(thrown.reason, "NO_COST_VERIFIABLE_BINDING");
  }

  const bad = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costMalformed(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(bad.status, "BLOCKED");
  if (bad.status === "BLOCKED") {
    assert.equal(bad.reason, "NO_COST_VERIFIABLE_BINDING");
  }
});

test("S11: cost WITHIN preferred by quota order; OVER/UNKNOWN/mismatch skipped; no cheapest", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });

  const overThenWithin = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costOver(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin("50"),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(overThenWithin.status, "SELECTED");
  if (overThenWithin.status === "SELECTED") {
    assert.equal(overThenWithin.binding_id, "builder-b");
    assert.equal(overThenWithin.cost_state, "ESTIMATE_AVAILABLE");
    assert.equal(overThenWithin.estimate.amount_decimal, "50");
    assert.equal(overThenWithin.quota_state, "UNKNOWN");
  }

  // Cheaper lower-priority must not beat higher-priority WITHIN
  const noCheapest = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin("90"),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin("1"),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(noCheapest.status, "SELECTED");
  if (noCheapest.status === "SELECTED") {
    assert.equal(noCheapest.binding_id, "builder-a");
    assert.equal(noCheapest.estimate.amount_decimal, "90");
  }

  const mismatch = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costMismatch(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(mismatch.status, "BLOCKED");
  if (mismatch.status === "BLOCKED") {
    assert.equal(mismatch.reason, "NO_COST_VERIFIABLE_BINDING");
  }
});

test("S11: EXHAUSTED binding costProbe is not invoked", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  let aCost = 0;
  const outcome = await selectRoutedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        quotaProbe: quotaExhausted(),
        costProbe: () => {
          aCost += 1;
          return { estimate: { amount_decimal: "1", currency_code: "USD" } };
        },
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        quotaProbe: quotaAvailable(),
        costProbe: costWithin(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-b");
  }
  assert.equal(aCost, 0);
});

test("S11: pin WITHIN remains; UNKNOWN/OVER/mismatch → PINNED_BINDING_COST_NOT_VERIFIABLE without alternate", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const base = {
    registry,
    request: {
      role: "builder" as const,
      requiredCapabilities: [...BUILD_CAPS],
    },
    pinnedBindingId: "builder-a",
    costConstraint: TEST_COST_CONSTRAINT,
  };

  const within = await resolvePinnedBinding({
    ...base,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin("2"),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin("1"),
      },
    ]),
  });
  assert.equal(within.status, "SELECTED");
  if (within.status === "SELECTED") {
    assert.equal(within.binding_id, "builder-a");
    assert.equal(within.cost_state, "ESTIMATE_AVAILABLE");
    assert.equal(within.estimate.amount_decimal, "2");
  }

  for (const probe of [undefined, costOver(), costMismatch(), costThrows()]) {
    const blocked = await resolvePinnedBinding({
      ...base,
      catalog: catalogByBindingId([
        {
          binding_id: "builder-a",
          role: "builder",
          adapter: builderA,
          probe: available(),
          ...(probe ? { costProbe: probe } : {}),
        },
        {
          binding_id: "builder-b",
          role: "builder",
          adapter: builderB,
          probe: available(),
          costProbe: costWithin(),
        },
      ]),
    });
    assert.equal(blocked.status, "BLOCKED");
    if (blocked.status === "BLOCKED") {
      assert.equal(blocked.reason, "PINNED_BINDING_COST_NOT_VERIFIABLE");
      assert.equal(blocked.pinned_binding_id, "builder-a");
    }
  }
});

test("S11: sanitizeCostRoutingObservations strips raw detail; keeps estimate", async () => {
  const { sanitizeCostRoutingObservations, sanitizeCostConstraintSnapshot } =
    await import("./routing.js");
  const cleaned = sanitizeCostRoutingObservations([
    {
      binding_id: "x",
      state: "ESTIMATE_AVAILABLE",
      estimate: { amount_decimal: "1.50", currency_code: "USD" },
      detail: "secret rate card",
    },
    {
      binding_id: "y",
      state: "UNKNOWN",
      detail: "probe timeout",
    },
  ]);
  assert.deepEqual(cleaned, [
    {
      binding_id: "x",
      state: "ESTIMATE_AVAILABLE",
      estimate: { amount_decimal: "1.50", currency_code: "USD" },
    },
    { binding_id: "y", state: "UNKNOWN" },
  ]);
  assert.equal("detail" in cleaned[0]!, false);
  const snap = sanitizeCostConstraintSnapshot(TEST_COST_CONSTRAINT);
  assert.deepEqual(snap, {
    max_estimate: { amount_decimal: "100", currency_code: "USD" },
  });
});

test("S11: NO_COST_VERIFIABLE_BINDING recovery evidence includes cost snapshot; no dispatch", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s11-cost-block");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          authorized_finding_ids: [],
          install_policy: null,
        }),
      ],
      envClock,
    );
    const builderA = new FakeBuilderAdapter([], envClock);
    const builderB = new FakeBuilderAdapter([], envClock);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costOver(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costOver(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry,
          catalog,
          costConstraint: TEST_COST_CONSTRAINT,
        },
      },
    );
    const last = await dispatcher.runUntilStable(cycle.cycle_id);
    assert.equal(last.action, "routing_blocked");
    assert.equal(builderA.invocations, 0);
    assert.equal(builderB.invocations, 0);
    const block = handoff.store
      .listEvents()
      .find((e) => e.event_type === "cycle.routing_blocked");
    assert.ok(block);
    const payload = block!.payload as {
      router_status: string;
      cost_observations: {
        binding_id: string;
        state: string;
        estimate?: { amount_decimal: string; currency_code: string };
        detail?: string;
      }[];
      cost_constraint: {
        max_estimate: { amount_decimal: string; currency_code: string };
      };
    };
    assert.equal(payload.router_status, "NO_COST_VERIFIABLE_BINDING");
    assert.ok(Array.isArray(payload.cost_observations));
    assert.ok(
      payload.cost_observations.every(
        (o) =>
          (o.state === "ESTIMATE_AVAILABLE" || o.state === "UNKNOWN") &&
          !("detail" in o && o.detail),
      ),
    );
    assert.deepEqual(payload.cost_constraint, {
      max_estimate: { amount_decimal: "100", currency_code: "USD" },
    });
    const dispatchCount = (
      handoff.store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM dispatches WHERE target_role = 'builder'`,
        )
        .get() as { c: number }
    ).c;
    assert.equal(dispatchCount, 0);
  } finally {
    cleanup(dir);
  }
});

test("S11: valid CLAIMED lease reuses binding without cost reprobe", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s11-claimed");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    let costProbes = 0;
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-claimed" }],
      envClock,
    );
    builder.identity = { adapter_id: "fake-builder", role: "builder" };
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const countingCost: CostProbeFn = () => {
      costProbes += 1;
      return { estimate: { amount_decimal: "1", currency_code: "USD" } };
    };
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builder,
        probe: available(),
        costProbe: countingCost,
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry,
          catalog,
          costConstraint: TEST_COST_CONSTRAINT,
        },
      },
    );
    let last = await dispatcher.step(cycle.cycle_id);
    while (last.cycle.state !== "DISPATCHING_BUILD") {
      last = await dispatcher.step(cycle.cycle_id);
      if (last.cycle.state === "RECOVERY_REQUIRED") break;
    }
    assert.equal(last.cycle.state, "DISPATCHING_BUILD");
    const reqId = last.cycle.current_request_id!;
    // Pre-claim with attribution so resolveRoutedAdapter takes CLAIMED reuse path (A-030).
    handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId,
      targetRole: "builder",
      owner: "disp",
      leaseMs: 60_000,
      bindingId: "builder-a",
    });
    assert.equal(costProbes, 0);
    last = await dispatcher.step(cycle.cycle_id);
    assert.equal(costProbes, 0);
    assert.equal(builder.invocations, 1);
  } finally {
    cleanup(dir);
  }
});

// --- WP-004-S12 Automatic Escalation (A-031..A-034) ---

test("S12: primary when first S1 eligible wins live routing", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.baseline_binding_id, "builder-a");
    assert.equal(outcome.selected_binding_id, "builder-a");
    assert.equal(outcome.binding_id, "builder-a");
    assert.equal(outcome.automatic_escalation, "PRIMARY");
    assert.doesNotMatch(
      JSON.stringify(outcome),
      /stronger|premium|better/i,
    );
  }
});

test("S12: escalated when availability skips S1 baseline to later eligible", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: unavailable("agent"),
      costProbe: costWithin(),
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.baseline_binding_id, "builder-a");
    assert.equal(outcome.selected_binding_id, "builder-b");
    assert.equal(outcome.binding_id, "builder-b");
    assert.equal(outcome.automatic_escalation, "ESCALATED");
  }
});

test("S12: escalated when quota exhausts baseline; later UNKNOWN/AVAILABLE wins", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaExhausted(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin(),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.baseline_binding_id, "builder-a");
    assert.equal(outcome.selected_binding_id, "builder-b");
    assert.equal(outcome.automatic_escalation, "ESCALATED");
  }
});

test("S12: escalated when cost ceiling excludes baseline; later within ceiling", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costOver(),
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin("2"),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.baseline_binding_id, "builder-a");
    assert.equal(outcome.selected_binding_id, "builder-b");
    assert.equal(outcome.automatic_escalation, "ESCALATED");
    assert.equal(outcome.estimate.amount_decimal, "2");
    assert.equal(outcome.estimate.currency_code, "USD");
  }
});

test("S12: escalated when baseline cost UNKNOWN; later within ceiling", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      // missing costProbe -> UNKNOWN (A-027)
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin("3"),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const frozenConstraint = { ...TEST_COST_CONSTRAINT };
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: frozenConstraint,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.baseline_binding_id, "builder-a");
    assert.equal(outcome.selected_binding_id, "builder-b");
    assert.equal(outcome.automatic_escalation, "ESCALATED");
    assert.deepEqual(frozenConstraint, TEST_COST_CONSTRAINT);
  }
});

test("S12: escalated when baseline currency mismatch; later within ceiling", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costMismatch(),
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costWithin("4"),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.baseline_binding_id, "builder-a");
    assert.equal(outcome.selected_binding_id, "builder-b");
    assert.equal(outcome.automatic_escalation, "ESCALATED");
    assert.equal(outcome.estimate.currency_code, "USD");
  }
});

test("S12: routing block does not fabricate escalation evidence", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costOver(),
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costOver(),
      quotaProbe: quotaAvailable(),
    },
  ]);
  const outcome = await selectRoutedBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(outcome.status, "BLOCKED");
  if (outcome.status === "BLOCKED") {
    assert.equal(outcome.reason, "NO_COST_VERIFIABLE_BINDING");
    assert.equal(
      "automatic_escalation" in outcome,
      false,
    );
  }
});

test("S12: pin path never escalates to alternate", async () => {
  const registry = multiBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const pinned = await resolvePinnedBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: unavailable("cred"),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    pinnedBindingId: "builder-a",
    costConstraint: TEST_COST_CONSTRAINT,
  });
  assert.equal(pinned.status, "BLOCKED");
  if (pinned.status === "BLOCKED") {
    assert.equal(pinned.reason, "PINNED_BINDING_UNAVAILABLE");
    assert.equal(pinned.pinned_binding_id, "builder-a");
  }
});

test("S12: durable cycle.routing_selected after successful escalated claim", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s12-escalated");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          authorized_finding_ids: ["f-keep"],
          install_policy: null,
        }),
      ],
      envClock,
    );
    const builderA = new FakeBuilderAdapter([], envClock);
    const builderB = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-esc" }],
      envClock,
    );
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: unavailable("agent"),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin("3"),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );
    let last = await dispatcher.step(cycle.cycle_id);
    while (
      last.cycle.state !== "AWAITING_PC" &&
      last.cycle.state !== "RECOVERY_REQUIRED" &&
      last.cycle.state !== "ACCEPTED"
    ) {
      last = await dispatcher.step(cycle.cycle_id);
      if (builderB.invocations >= 1 && last.cycle.state === "AWAITING_PC") break;
    }
    assert.equal(builderA.invocations, 0);
    assert.equal(builderB.invocations, 1);

    const selectedEv = handoff.store
      .listEvents()
      .filter((e) => e.event_type === "cycle.routing_selected");
    const builderSelected = selectedEv.find(
      (e) => (e.payload as { target_role?: string }).target_role === "builder",
    );
    assert.ok(builderSelected);
    const payload = builderSelected!.payload as {
      cycle_id: string;
      request_id: string;
      dispatch_id: string;
      target_role: string;
      binding_id: string;
      baseline_binding_id: string;
      automatic_escalation: boolean;
      required_capabilities: string[];
      observations: unknown[];
      quota_observations: unknown[];
      cost_observations: unknown[];
      cost_constraint: { max_estimate: { amount_decimal: string; currency_code: string } };
    };
    assert.equal(payload.cycle_id, cycle.cycle_id);
    assert.equal(payload.target_role, "builder");
    assert.equal(payload.binding_id, "builder-b");
    assert.equal(payload.baseline_binding_id, "builder-a");
    assert.equal(payload.automatic_escalation, true);
    assert.equal(payload.cost_constraint.max_estimate.amount_decimal, "100");
    assert.equal(payload.cost_constraint.max_estimate.currency_code, "USD");
    assert.ok(Array.isArray(payload.required_capabilities));
    assert.ok(Array.isArray(payload.observations));
    assert.ok(Array.isArray(payload.quota_observations));
    assert.ok(Array.isArray(payload.cost_observations));
    assert.doesNotMatch(JSON.stringify(payload), /stronger|premium|better/i);

    const claimed = handoff.store
      .listEvents()
      .filter(
        (e) =>
          e.event_type === "cycle.dispatch_claimed" &&
          (e.payload as { binding_id?: string }).binding_id === "builder-b",
      );
    assert.ok(claimed.length >= 1);
    assert.equal(
      (claimed[0]!.payload as { request_id: string }).request_id,
      payload.request_id,
    );
    // F001 / A-034 atomicity: claim + routing_selected share dispatch_id
    assert.equal(
      (claimed[0]!.payload as { dispatch_id: string }).dispatch_id,
      payload.dispatch_id,
    );
    const claimedRow = handoff.getDispatch(payload.dispatch_id);
    assert.ok(claimedRow);
    assert.equal(claimedRow!.binding_id, "builder-b");
    assert.ok(
      claimedRow!.state === "CLAIMED" || claimedRow!.state === "ACCEPTED",
    );

    const buildReq = handoff
      .listEnvelopes(cycle.cycle_id)
      .find(
        (e) =>
          e.kind === "control_request" &&
          e.request_id === payload.request_id,
      ) as
      | {
          body: {
            required_capabilities: string[];
            authorized_finding_ids: string[];
            base_sha: string;
            target_sha: string | null;
          };
        }
      | undefined;
    assert.ok(buildReq);
    assert.deepEqual(
      buildReq!.body.required_capabilities,
      payload.required_capabilities,
    );
    assert.deepEqual(buildReq!.body.authorized_finding_ids, ["f-keep"]);
  } finally {
    cleanup(dir);
  }
});

test("S12: primary claim emits automatic_escalation=false; no event on routing block", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s12-primary");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: null,
        }),
      ],
      envClock,
    );
    const builder = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-p" }],
      envClock,
    );
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builder,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );
    let last = await dispatcher.step(cycle.cycle_id);
    while (
      last.cycle.state !== "AWAITING_PC" &&
      last.cycle.state !== "RECOVERY_REQUIRED"
    ) {
      last = await dispatcher.step(cycle.cycle_id);
      if (builder.invocations >= 1) break;
    }
    const builderSelected = handoff.store
      .listEvents()
      .find(
        (e) =>
          e.event_type === "cycle.routing_selected" &&
          (e.payload as { target_role?: string }).target_role === "builder",
      );
    assert.ok(builderSelected);
    const payload = builderSelected!.payload as {
      binding_id: string;
      baseline_binding_id: string;
      automatic_escalation: boolean;
      dispatch_id: string;
      request_id: string;
    };
    assert.equal(payload.binding_id, "builder-a");
    assert.equal(payload.baseline_binding_id, "builder-a");
    assert.equal(payload.automatic_escalation, false);
    // F001 / A-034 atomicity: primary claim + routing_selected share dispatch_id
    const claimedPrimary = handoff.store
      .listEvents()
      .find(
        (e) =>
          e.event_type === "cycle.dispatch_claimed" &&
          (e.payload as { dispatch_id?: string }).dispatch_id ===
            payload.dispatch_id,
      );
    assert.ok(claimedPrimary);
    assert.equal(
      (claimedPrimary!.payload as { binding_id: string }).binding_id,
      "builder-a",
    );
    assert.equal(
      (claimedPrimary!.payload as { request_id: string }).request_id,
      payload.request_id,
    );
    const claimedRow = handoff.getDispatch(payload.dispatch_id);
    assert.ok(claimedRow);
    assert.equal(claimedRow!.binding_id, "builder-a");

    // Separate blocked cycle: no routing_selected for builder
    const cycle2 = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base2",
    });
    const pc2 = new FakeProgramControlAdapter(
      [pcDecision({ decision: "BUILD", install_policy: null })],
      envClock,
    );
    const builderFail = new FakeBuilderAdapter([], envClock);
    const catalogBlock: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc2,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderFail,
        probe: available(),
        costProbe: costOver(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: new FakeBuilderAdapter([], envClock),
        probe: available(),
        costProbe: costOver(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const blocked = new Dispatcher(
      handoff,
      { programControl: pc2, builder: builderFail, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry,
          catalog: catalogBlock,
          costConstraint: TEST_COST_CONSTRAINT,
        },
      },
    );
    const before = handoff.store
      .listEvents()
      .filter(
        (e) =>
          e.event_type === "cycle.routing_selected" &&
          (e.payload as { target_role?: string }).target_role === "builder",
      ).length;
    const blockedStep = await blocked.runUntilStable(cycle2.cycle_id);
    assert.equal(blockedStep.action, "routing_blocked");
    const after = handoff.store
      .listEvents()
      .filter(
        (e) =>
          e.event_type === "cycle.routing_selected" &&
          (e.payload as { target_role?: string }).target_role === "builder",
      ).length;
    assert.equal(after, before);
  } finally {
    cleanup(dir);
  }
});

test("S12: after attribution pin retry does not emit escalated alternate", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s12-pin-no-esc");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 3,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    let aCalls = 0;
    const builderA = new FakeBuilderAdapter([], envClock);
    const origBuild = builderA.build.bind(builderA);
    builderA.build = (input) => {
      aCalls += 1;
      if (aCalls === 1) {
        throw new Error("builder-a boom");
      }
      return origBuild(input);
    };
    builderA.identity = { adapter_id: "fake-builder", role: "builder" };
    const builderB = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-b" }],
      envClock,
    );
    builderB.identity = { adapter_id: "fake-builder-b", role: "builder" };
    const reviewer = new FakeReviewerAdapter([], envClock);
    reviewer.identity = { adapter_id: "catalog-reviewer", role: "reviewer" };
    const registry = multiBuilderRegistry();
    let aProbe: AvailabilityProbeFn = available();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: () => aProbe(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );
    let last = await dispatcher.step(cycle.cycle_id);
    while (aCalls === 0 && last.cycle.state !== "RECOVERY_REQUIRED") {
      last = await dispatcher.step(cycle.cycle_id);
    }
    assert.equal(aCalls, 1);
    // Make baseline unavailable so a naive reselect would pick builder-b.
    aProbe = unavailable("agent");
    // Drive recovery / retry on same request (pin).
    for (let i = 0; i < 16; i += 1) {
      last = await dispatcher.step(cycle.cycle_id);
      if (aCalls >= 2) break;
      if (
        last.cycle.state === "RECOVERY_REQUIRED" ||
        last.cycle.state === "ABORTED"
      ) {
        // pin block if unavailable — still must not invoke builder-b
        break;
      }
    }
    assert.equal(builderB.invocations, 0);
    const escEvents = handoff.store
      .listEvents()
      .filter(
        (e) =>
          e.event_type === "cycle.routing_selected" &&
          (e.payload as { automatic_escalation?: boolean })
            .automatic_escalation === true &&
          (e.payload as { binding_id?: string }).binding_id === "builder-b",
      );
    assert.equal(escEvents.length, 0);
  } finally {
    cleanup(dir);
  }
});

// ─── WP-004-S13 Failover Under Fencing ─────────────────────────────────────

function threeBuilderRegistry(): ProviderRegistry {
  return parseProviderRegistryJson(
    JSON.stringify({
      protocol: PROVIDER_REGISTRY_PROTOCOL,
      bindings: [
        {
          binding_id: "builder-a",
          role: "builder",
          provider_id: "prov-a",
          runtime_id: "rt-a",
          capabilities: [...BUILD_CAPS],
          priority: 10,
          enabled: true,
        },
        {
          binding_id: "builder-b",
          role: "builder",
          provider_id: "prov-b",
          runtime_id: "rt-b",
          capabilities: [...BUILD_CAPS],
          priority: 20,
          enabled: true,
        },
        {
          binding_id: "builder-c",
          role: "builder",
          provider_id: "prov-c",
          runtime_id: "rt-c",
          capabilities: [...BUILD_CAPS],
          priority: 30,
          enabled: true,
        },
        {
          binding_id: "pc-main",
          role: "program_control",
          provider_id: "prov-pc",
          runtime_id: "rt-pc",
          capabilities: ["repository_read"],
          priority: 10,
          enabled: true,
        },
        {
          binding_id: "reviewer-main",
          role: "reviewer",
          provider_id: "prov-rev",
          runtime_id: "rt-rev",
          capabilities: [...REVIEW_CAPS],
          priority: 10,
          enabled: true,
        },
      ],
    }),
  );
}

test("S13: parseFailoverPolicy opt-in / malformed", () => {
  assert.equal(parseFailoverPolicy(undefined), undefined);
  assert.deepEqual(parseFailoverPolicy({ mode: "FENCED" }), { mode: "FENCED" });
  for (const bad of [
    null,
    "FENCED",
    {},
    { mode: "AUTO" },
    { mode: "FENCED", extra: 1 },
    [],
  ]) {
    assert.throws(
      () => parseFailoverPolicy(bad),
      (err: unknown) =>
        err instanceof ControlError && err.code === "ROUTING_CONFIG_INVALID",
    );
  }
});

test("S13: isFailoverEligiblePrior only EXPIRED and allowed REJECTED classes", () => {
  assert.equal(isFailoverEligiblePrior({ state: "EXPIRED", failure_class: null }), true);
  for (const fc of [
    "AGENT_UNAVAILABLE",
    "CREDENTIAL_UNAVAILABLE",
    "RUNTIME_ERROR",
  ] as const) {
    assert.equal(
      isFailoverEligiblePrior({ state: "REJECTED", failure_class: fc }),
      true,
    );
  }
  for (const fc of [
    "CAPABILITY_BLOCK",
    "REPO_UNAVAILABLE",
    "RESULT_INVALID",
    "RESULT_STALE",
    "PRODUCT_FAILURE",
  ] as const) {
    assert.equal(
      isFailoverEligiblePrior({ state: "REJECTED", failure_class: fc }),
      false,
    );
  }
  for (const state of ["CLAIMED", "ACCEPTED", "RECOVERED"] as const) {
    assert.equal(
      isFailoverEligiblePrior({ state, failure_class: "RUNTIME_ERROR" }),
      false,
    );
  }
});

test("S13: default / absent failoverPolicy preserves pin no-alternate", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s13-default");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 3,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    let aCalls = 0;
    const builderA = new FakeBuilderAdapter([], envClock);
    builderA.build = async () => {
      aCalls += 1;
      throw new Error("builder-a boom");
    };
    builderA.identity = { adapter_id: "fake-builder", role: "builder" };
    const builderB = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-b" }],
      envClock,
    );
    builderB.identity = { adapter_id: "fake-builder", role: "builder" };
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    let aProbe: AvailabilityProbeFn = available();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: () => aProbe(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    // No failoverPolicy → DISABLED
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: { registry, catalog, costConstraint: TEST_COST_CONSTRAINT },
      },
    );
    let last = await dispatcher.step(cycle.cycle_id);
    while (aCalls === 0 && last.cycle.state !== "RECOVERY_REQUIRED") {
      last = await dispatcher.step(cycle.cycle_id);
      if (last.action === "runtime_error") break;
    }
    assert.equal(aCalls, 1);
    aProbe = unavailable("agent");
    last = await dispatcher.step(cycle.cycle_id);
    assert.equal(last.action, "routing_blocked");
    assert.equal(builderB.invocations, 0);
    assert.equal(
      handoff.store.listEvents().filter((e) => e.event_type === "cycle.failover_selected")
        .length,
      0,
    );
  } finally {
    cleanup(dir);
  }
});

test("S13: malformed failoverPolicy → ROUTING_CONFIG_INVALID at construction", () => {
  const registry = multiBuilderRegistry();
  const pc = new FakeProgramControlAdapter([], { id: () => "x", now: () => "t" });
  const builder = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const reviewer = new FakeReviewerAdapter([], { id: () => "x", now: () => "t" });
  const dir = tempState();
  try {
    const { store, handoff } = openHarness(dir);
    assert.throws(
      () =>
        new Dispatcher(
          handoff,
          { programControl: pc, builder, reviewer },
          {
            owner: "disp",
            leaseMs: 60_000,
            routing: {
              registry,
              catalog: [
                {
                  binding_id: "pc-main",
                  role: "program_control",
                  adapter: pc,
                  probe: available(),
                  costProbe: costWithin(),
                },
                {
                  binding_id: "builder-a",
                  role: "builder",
                  adapter: builder,
                  probe: available(),
                  costProbe: costWithin(),
                },
                {
                  binding_id: "reviewer-main",
                  role: "reviewer",
                  adapter: reviewer,
                  probe: available(),
                  costProbe: costWithin(),
                },
              ],
              costConstraint: TEST_COST_CONSTRAINT,
              failoverPolicy: { mode: "AUTO" } as never,
            },
          },
        ),
      (err: unknown) =>
        err instanceof ControlError && err.code === "ROUTING_CONFIG_INVALID",
    );
  } finally {
    cleanup(dir);
  }
});

async function driveToBuilderReject(args: {
  handoff: HandoffStore;
  dispatcher: Dispatcher;
  cycleId: string;
  failBuilder: FakeBuilderAdapter;
  failWith: Error | ControlError;
}): Promise<{
  requestId: string;
  first: { dispatch_id: string; fence_token: string; attempt_number: number; binding_id: string | null; state: string; failure_class: string | null };
}> {
  const orig = args.failBuilder.build.bind(args.failBuilder);
  let calls = 0;
  args.failBuilder.build = async (input) => {
    calls += 1;
    if (calls === 1) throw args.failWith;
    return orig(input);
  };
  let last = await args.dispatcher.step(args.cycleId);
  while (calls === 0 && last.cycle.state !== "RECOVERY_REQUIRED") {
    last = await args.dispatcher.step(args.cycleId);
    if (last.action === "runtime_error" || last.action === "result_invalid" || last.action === "result_stale") break;
  }
  assert.ok(calls >= 1);
  const row = args.handoff.store.db
    .prepare(
      `SELECT dispatch_id, fence_token, attempt_number, binding_id, state, failure_class
       FROM dispatches WHERE target_role = 'builder' ORDER BY attempt_number LIMIT 1`,
    )
    .get() as {
    dispatch_id: string;
    fence_token: string;
    attempt_number: number;
    binding_id: string | null;
    state: string;
    failure_class: string | null;
  };
  const requestId = args.handoff.requireCycle(args.cycleId).current_request_id!;
  return { requestId, first: row };
}

test("S13: eligible REJECTED+RUNTIME_ERROR fails over to alternate with identity + evidence", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s13-runtime");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 4,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    const builderA = new FakeBuilderAdapter([], envClock);
    builderA.identity = { adapter_id: "fake-builder", role: "builder" };
    const builderB = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-failover" }],
      envClock,
    );
    builderB.identity = { adapter_id: "fake-builder", role: "builder" };
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin("2"),
        quotaProbe: quotaAvailable(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry,
          catalog,
          costConstraint: TEST_COST_CONSTRAINT,
          failoverPolicy: { mode: "FENCED" },
        },
      },
    );
    const { requestId, first } = await driveToBuilderReject({
      handoff,
      dispatcher,
      cycleId: cycle.cycle_id,
      failBuilder: builderA,
      failWith: new Error("runtime boom"),
    });
    assert.equal(first.state, "REJECTED");
    assert.equal(first.failure_class, "RUNTIME_ERROR");
    assert.equal(first.binding_id, "builder-a");

    let last = await dispatcher.step(cycle.cycle_id);
    while (
      builderB.invocations === 0 &&
      last.cycle.state !== "RECOVERY_REQUIRED" &&
      last.cycle.state !== "AWAITING_PC"
    ) {
      last = await dispatcher.step(cycle.cycle_id);
      if (builderB.invocations >= 1) break;
    }
    assert.equal(builderB.invocations, 1);

    const builds = handoff.listDispatchesForRequest(cycle.cycle_id, requestId);
    assert.equal(builds.length, 2);
    assert.equal(builds[0]!.binding_id, "builder-a");
    assert.equal(builds[1]!.binding_id, "builder-b");
    assert.equal(builds[1]!.request_id, requestId);
    assert.equal(builds[1]!.request_id, builds[0]!.request_id);
    assert.notEqual(builds[1]!.dispatch_id, builds[0]!.dispatch_id);
    assert.notEqual(builds[1]!.fence_token, builds[0]!.fence_token);
    assert.equal(builds[1]!.attempt_number, builds[0]!.attempt_number + 1);

    const fo = handoff.store
      .listEvents()
      .filter((e) => e.event_type === "cycle.failover_selected");
    assert.equal(fo.length, 1);
    const payload = fo[0]!.payload as {
      request_id: string;
      dispatch_id: string;
      binding_id: string;
      prior_binding_id: string;
      prior_dispatch_id: string;
      cost_constraint: { max_estimate: { amount_decimal: string; currency_code: string } };
      excluded_binding_ids: string[];
    };
    assert.equal(payload.request_id, requestId);
    assert.equal(payload.dispatch_id, builds[1]!.dispatch_id);
    assert.equal(payload.binding_id, "builder-b");
    assert.equal(payload.prior_binding_id, "builder-a");
    assert.equal(payload.prior_dispatch_id, builds[0]!.dispatch_id);
    assert.deepEqual(payload.excluded_binding_ids, ["builder-a"]);
    assert.equal(payload.cost_constraint.max_estimate.amount_decimal, "100");
    assert.equal(payload.cost_constraint.max_estimate.currency_code, "USD");
    assert.equal(
      handoff.store.listEvents().filter((e) => e.event_type === "cycle.routing_selected")
        .filter((e) => (e.payload as { target_role?: string }).target_role === "builder")
        .length,
      1,
    ); // initial claim only
  } finally {
    cleanup(dir);
  }
});

test("S13: eligible AGENT_UNAVAILABLE / CREDENTIAL_UNAVAILABLE / EXPIRED fail over", async () => {
  for (const kind of ["agent", "cred", "expired"] as const) {
    const dir = tempState();
    try {
      const { store, handoff, envClock } = openHarness(dir);
      const project = store.createProject(`s13-${kind}`);
      const cycle = handoff.createCycle({
        projectId: project.project_id,
        workPackageRef: "WP-004",
        baseSha: "base",
        maxDispatchRetries: 4,
      });
      const pc = new FakeProgramControlAdapter(
        [
          pcDecision({
            decision: "BUILD",
            install_policy: { on_builder_candidate: "AWAIT_PC" },
          }),
        ],
        envClock,
      );
      const builderA = new FakeBuilderAdapter([], envClock);
      builderA.identity = { adapter_id: "fake-builder", role: "builder" };
      const builderB = new FakeBuilderAdapter(
        [{ status: "CANDIDATE_READY", candidate_sha: `sha-${kind}` }],
        envClock,
      );
      builderB.identity = { adapter_id: "fake-builder", role: "builder" };
      const reviewer = new FakeReviewerAdapter([], envClock);
      const registry = multiBuilderRegistry();
      const catalog: RuntimeCatalogEntry[] = [
        {
          binding_id: "pc-main",
          role: "program_control",
          adapter: pc,
          probe: available(),
          costProbe: costWithin(),
        },
        {
          binding_id: "builder-a",
          role: "builder",
          adapter: builderA,
          probe: available(),
          costProbe: costWithin(),
        },
        {
          binding_id: "builder-b",
          role: "builder",
          adapter: builderB,
          probe: available(),
          costProbe: costWithin(),
        },
        {
          binding_id: "reviewer-main",
          role: "reviewer",
          adapter: reviewer,
          probe: available(),
          costProbe: costWithin(),
        },
      ];
      const dispatcher = new Dispatcher(
        handoff,
        { programControl: pc, builder: builderA, reviewer },
        {
          owner: "disp",
          leaseMs: 60_000,
          routing: {
            registry,
            catalog,
            costConstraint: TEST_COST_CONSTRAINT,
            failoverPolicy: { mode: "FENCED" },
          },
        },
      );

      if (kind === "expired") {
        let last = await dispatcher.step(cycle.cycle_id);
        while (last.cycle.state !== "DISPATCHING_BUILD") {
          last = await dispatcher.step(cycle.cycle_id);
        }
        const reqId = last.cycle.current_request_id!;
        // Claim A then force EXPIRED (fence dead)
        const claimed = handoff.claimDispatch({
          cycleId: cycle.cycle_id,
          requestId: reqId,
          targetRole: "builder",
          owner: "disp",
          leaseMs: 1,
          bindingId: "builder-a",
        });
        store.db
          .prepare(
            `UPDATE dispatches SET state = 'EXPIRED', lease_expires_at = ? WHERE dispatch_id = ?`,
          )
          .run(new Date(0).toISOString(), claimed.dispatch_id);
        last = await dispatcher.step(cycle.cycle_id);
        while (
          builderB.invocations === 0 &&
          last.cycle.state !== "RECOVERY_REQUIRED" &&
          last.cycle.state !== "AWAITING_PC"
        ) {
          last = await dispatcher.step(cycle.cycle_id);
          if (builderB.invocations >= 1) break;
        }
        assert.equal(builderB.invocations, 1, `expired→failover`);
        const builds = handoff.listDispatchesForRequest(cycle.cycle_id, reqId);
        assert.equal(builds[1]!.binding_id, "builder-b");
      } else {
        const code =
          kind === "agent" ? "AGENT_UNAVAILABLE" : "CREDENTIAL_UNAVAILABLE";
        const { requestId } = await driveToBuilderReject({
          handoff,
          dispatcher,
          cycleId: cycle.cycle_id,
          failBuilder: builderA,
          failWith: new ControlError(code, `${kind} down`),
        });
        let last = await dispatcher.step(cycle.cycle_id);
        while (
          builderB.invocations === 0 &&
          last.cycle.state !== "RECOVERY_REQUIRED"
        ) {
          last = await dispatcher.step(cycle.cycle_id);
          if (builderB.invocations >= 1) break;
        }
        assert.equal(builderB.invocations, 1, `${kind}→failover`);
        const builds = handoff.listDispatchesForRequest(cycle.cycle_id, requestId);
        assert.equal(builds[0]!.failure_class, code);
        assert.equal(builds[1]!.binding_id, "builder-b");
      }
    } finally {
      cleanup(dir);
    }
  }
});

test("S13: excluded terminal classes do not fail over", async () => {
  for (const fc of [
    "CAPABILITY_BLOCK",
    "REPO_UNAVAILABLE",
    "RESULT_INVALID",
    "RESULT_STALE",
    "PRODUCT_FAILURE",
  ] as const) {
    const dir = tempState();
    try {
      const { store, handoff, envClock } = openHarness(dir);
      const project = store.createProject(`s13-excl-${fc}`);
      const cycle = handoff.createCycle({
        projectId: project.project_id,
        workPackageRef: "WP-004",
        baseSha: "base",
        maxDispatchRetries: 4,
      });
      const pc = new FakeProgramControlAdapter(
        [
          pcDecision({
            decision: "BUILD",
            install_policy: { on_builder_candidate: "AWAIT_PC" },
          }),
        ],
        envClock,
      );
      const builderA = new FakeBuilderAdapter([], envClock);
      builderA.identity = { adapter_id: "fake-builder", role: "builder" };
      const builderB = new FakeBuilderAdapter(
        [{ status: "CANDIDATE_READY", candidate_sha: "sha-x" }],
        envClock,
      );
      builderB.identity = { adapter_id: "fake-builder", role: "builder" };
      const reviewer = new FakeReviewerAdapter([], envClock);
      let aProbe: AvailabilityProbeFn = available();
      const catalog: RuntimeCatalogEntry[] = [
        {
          binding_id: "pc-main",
          role: "program_control",
          adapter: pc,
          probe: available(),
          costProbe: costWithin(),
        },
        {
          binding_id: "builder-a",
          role: "builder",
          adapter: builderA,
          probe: () => aProbe(),
          costProbe: costWithin(),
        },
        {
          binding_id: "builder-b",
          role: "builder",
          adapter: builderB,
          probe: available(),
          costProbe: costWithin(),
        },
        {
          binding_id: "reviewer-main",
          role: "reviewer",
          adapter: reviewer,
          probe: available(),
          costProbe: costWithin(),
        },
      ];
      const dispatcher = new Dispatcher(
        handoff,
        { programControl: pc, builder: builderA, reviewer },
        {
          owner: "disp",
          leaseMs: 60_000,
          routing: {
            registry: multiBuilderRegistry(),
            catalog,
            costConstraint: TEST_COST_CONSTRAINT,
            failoverPolicy: { mode: "FENCED" },
          },
        },
      );
      let last = await dispatcher.step(cycle.cycle_id);
      while (last.cycle.state !== "DISPATCHING_BUILD") {
        last = await dispatcher.step(cycle.cycle_id);
      }
      const reqId = last.cycle.current_request_id!;
      const claimed = handoff.claimDispatch({
        cycleId: cycle.cycle_id,
        requestId: reqId,
        targetRole: "builder",
        owner: "disp",
        leaseMs: 60_000,
        bindingId: "builder-a",
      });
      handoff.rejectResult({
        dispatchId: claimed.dispatch_id,
        fenceToken: claimed.fence_token,
        failureClass: fc,
        detail: `excluded ${fc}`,
      });
      aProbe = unavailable("agent");
      last = await dispatcher.step(cycle.cycle_id);
      assert.equal(builderB.invocations, 0, `no failover for ${fc}`);
      assert.equal(last.action, "routing_blocked");
      assert.equal(
        handoff.store.listEvents().filter((e) => e.event_type === "cycle.failover_selected")
          .length,
        0,
      );
    } finally {
      cleanup(dir);
    }
  }
});

test("S13: live CLAIMED does not fail over", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s13-claimed");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 4,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    const builderA = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-a" }],
      envClock,
    );
    builderA.identity = { adapter_id: "fake-builder", role: "builder" };
    const builderB = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-b" }],
      envClock,
    );
    builderB.identity = { adapter_id: "fake-builder", role: "builder" };
    const reviewer = new FakeReviewerAdapter([], envClock);
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry: multiBuilderRegistry(),
          catalog,
          costConstraint: TEST_COST_CONSTRAINT,
          failoverPolicy: { mode: "FENCED" },
        },
      },
    );
    let last = await dispatcher.step(cycle.cycle_id);
    while (last.cycle.state !== "DISPATCHING_BUILD") {
      last = await dispatcher.step(cycle.cycle_id);
    }
    const reqId = last.cycle.current_request_id!;
    // Pre-claim live same-owner lease (A-030 reuse; A-036 no failover)
    handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId,
      targetRole: "builder",
      owner: "disp",
      leaseMs: 60_000,
      bindingId: "builder-a",
    });
    last = await dispatcher.step(cycle.cycle_id);
    assert.equal(builderA.invocations, 1);
    assert.equal(builderB.invocations, 0);
    assert.equal(
      handoff.store.listEvents().filter((e) => e.event_type === "cycle.failover_selected")
        .length,
      0,
    );
    const builds = handoff.listDispatchesForRequest(cycle.cycle_id, reqId);
    assert.equal(builds.length, 1);
    assert.equal(builds[0]!.binding_id, "builder-a");
  } finally {
    cleanup(dir);
  }
});

test("S13: old/dead fence late result cannot be accepted after failover claim", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s13-fence");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 4,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    const builderA = new FakeBuilderAdapter([], envClock);
    builderA.identity = { adapter_id: "fake-builder", role: "builder" };
    const builderB = new FakeBuilderAdapter(
      [{ status: "CANDIDATE_READY", candidate_sha: "sha-b" }],
      envClock,
    );
    builderB.identity = { adapter_id: "fake-builder", role: "builder" };
    const reviewer = new FakeReviewerAdapter([], envClock);
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry: multiBuilderRegistry(),
          catalog,
          costConstraint: TEST_COST_CONSTRAINT,
          failoverPolicy: { mode: "FENCED" },
        },
      },
    );
    const { requestId, first } = await driveToBuilderReject({
      handoff,
      dispatcher,
      cycleId: cycle.cycle_id,
      failBuilder: builderA,
      failWith: new Error("boom"),
    });
    const oldFence = first.fence_token;
    const oldDispatchId = first.dispatch_id;

    let last = await dispatcher.step(cycle.cycle_id);
    while (builderB.invocations === 0 && last.cycle.state !== "RECOVERY_REQUIRED") {
      last = await dispatcher.step(cycle.cycle_id);
      if (builderB.invocations >= 1) break;
    }
    assert.equal(builderB.invocations, 1);

    assert.throws(
      () =>
        handoff.acceptResult({
          dispatchId: oldDispatchId,
          fenceToken: oldFence,
          envelope: {
            protocol: PROTOCOL_V1,
            envelope_id: envClock.id("env"),
            kind: "builder_result",
            cycle_id: cycle.cycle_id,
            request_id: requestId,
            from_role: "builder",
            to_role: "program_control",
            created_at: envClock.now(),
            body: {
              status: "CANDIDATE_READY",
              candidate_sha: "late-old",
              evidence_refs: [],
              notes: null,
            },
          },
        }),
      (err: unknown) =>
        err instanceof ControlError && err.code === "STALE_FENCE",
    );
  } finally {
    cleanup(dir);
  }
});

test("S13: A→B→C progression; no A→B→A ping-pong; no candidate → recovery", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s13-abc");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
      maxDispatchRetries: 6,
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    const failAlways = async () => {
      throw new Error("always fail");
    };
    const builderA = new FakeBuilderAdapter([], envClock);
    builderA.identity = { adapter_id: "fake-builder", role: "builder" };
    builderA.build = failAlways;
    const builderB = new FakeBuilderAdapter([], envClock);
    builderB.identity = { adapter_id: "fake-builder", role: "builder" };
    builderB.build = failAlways;
    const builderC = new FakeBuilderAdapter([], envClock);
    builderC.identity = { adapter_id: "fake-builder", role: "builder" };
    builderC.build = failAlways;
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = threeBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-c",
        role: "builder",
        adapter: builderC,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry,
          catalog,
          costConstraint: TEST_COST_CONSTRAINT,
          failoverPolicy: { mode: "FENCED" },
        },
      },
    );

    let last = await dispatcher.step(cycle.cycle_id);
    let guard = 0;
    while (last.cycle.state !== "RECOVERY_REQUIRED" && guard < 40) {
      last = await dispatcher.step(cycle.cycle_id);
      guard += 1;
    }
    const buildRows = handoff.store.db
      .prepare(
        `SELECT binding_id, attempt_number, state FROM dispatches
         WHERE target_role = 'builder' ORDER BY attempt_number`,
      )
      .all() as Array<{ binding_id: string; attempt_number: number; state: string }>;
    assert.deepEqual(
      buildRows.map((r) => r.binding_id),
      ["builder-a", "builder-b", "builder-c"],
    );
    assert.equal(buildRows[0]!.attempt_number, 1);
    assert.equal(buildRows[1]!.attempt_number, 2);
    assert.equal(buildRows[2]!.attempt_number, 3);
    // No ping-pong back to A
    assert.ok(!buildRows.some((r, i) => i > 0 && r.binding_id === "builder-a"));

    // Exhausting untried candidates entered existing recovery (no fabricate)
    assert.equal(last.cycle.state, "RECOVERY_REQUIRED");
    const buildsAfter = handoff.store.db
      .prepare(`SELECT COUNT(*) AS n FROM dispatches WHERE target_role='builder'`)
      .get() as { n: number };
    assert.equal(Number(buildsAfter.n), 3);
  } finally {
    cleanup(dir);
  }
});

test("S13: selectFailoverBinding excludes attempted; quota/cost intact; no invented ceiling", async () => {
  const registry = threeBuilderRegistry();
  const builderA = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderB = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const builderC = new FakeBuilderAdapter([], { id: () => "x", now: () => "t" });
  const catalog = catalogByBindingId([
    {
      binding_id: "builder-a",
      role: "builder",
      adapter: builderA,
      probe: available(),
      costProbe: costWithin("1"),
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-b",
      role: "builder",
      adapter: builderB,
      probe: available(),
      costProbe: costOver(),
      quotaProbe: quotaAvailable(),
    },
    {
      binding_id: "builder-c",
      role: "builder",
      adapter: builderC,
      probe: available(),
      costProbe: costWithin("5"),
      quotaProbe: quotaAvailable(),
    },
  ]);
  // Exclude A; B over ceiling → C wins (quota+cost intact)
  const outcome = await selectFailoverBinding({
    registry,
    catalog,
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
    excludeBindingIds: new Set(["builder-a"]),
  });
  assert.equal(outcome.status, "SELECTED");
  if (outcome.status === "SELECTED") {
    assert.equal(outcome.binding_id, "builder-c");
    assert.deepEqual(outcome.excluded_binding_ids, ["builder-a"]);
    assert.equal(outcome.estimate.currency_code, "USD");
    assert.equal("automatic_escalation" in outcome, false);
  }

  // Exhausted quota on only remaining → block
  const blocked = await selectFailoverBinding({
    registry,
    catalog: catalogByBindingId([
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaExhausted(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderB,
        probe: available(),
        costProbe: costWithin(),
        quotaProbe: quotaExhausted(),
      },
    ]),
    request: { role: "builder", requiredCapabilities: [...BUILD_CAPS] },
    costConstraint: TEST_COST_CONSTRAINT,
    excludeBindingIds: new Set(["builder-a"]),
  });
  assert.equal(blocked.status, "BLOCKED");
  if (blocked.status === "BLOCKED") {
    assert.equal(blocked.reason, "NO_QUOTA_ROUTABLE_BINDING");
  }
});

test("S13: failover_selected + claim atomic; injected pre-COMMIT failure leaves no partial state", () => {
  const dir = tempState();
  try {
    const store = ControlStore.open({ stateDir: dir, idFactory: seqIds() });
    const handoff = new HandoffStore(store);
    const project = store.createProject("s13-atomic");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004-S13",
      baseSha: "base",
      maxDispatchRetries: 3,
    });
    const ts = store.now().toISOString();
    const reqId = "req_fo_atomic";
    handoff.persistEnvelope({
      protocol: PROTOCOL_V1,
      envelope_id: "env_req",
      kind: "control_request",
      cycle_id: cycle.cycle_id,
      request_id: reqId,
      from_role: "program_control",
      to_role: "builder",
      created_at: ts,
      body: {
        action: "BUILD",
        target_role: "builder",
        work_package_ref: "WP-004",
        base_sha: "base",
        target_sha: null,
        authoritative_references: [],
        required_capabilities: [...BUILD_CAPS],
        expected_result_kind: "builder_result",
        stop_condition: "CANDIDATE_READY",
        authorized_by_decision_id: null,
        authorized_finding_ids: [],
        retry_of_request_id: null,
      },
    });

    // Prior terminal attempt
    const prior = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId,
      targetRole: "builder",
      owner: "owner",
      leaseMs: 60_000,
      bindingId: "builder-a",
    });
    handoff.rejectResult({
      dispatchId: prior.dispatch_id,
      fenceToken: prior.fence_token,
      failureClass: "RUNTIME_ERROR",
      detail: "prior",
    });

    const claimed = handoff.claimDispatch({
      cycleId: cycle.cycle_id,
      requestId: reqId,
      targetRole: "builder",
      owner: "owner",
      leaseMs: 60_000,
      bindingId: "builder-b",
      coupledEvent: {
        eventType: "cycle.failover_selected",
        project_id: project.project_id,
        work_id: null,
        payload: {
          cycle_id: cycle.cycle_id,
          request_id: reqId,
          target_role: "builder",
          binding_id: "builder-b",
          prior_binding_id: "builder-a",
          prior_dispatch_id: prior.dispatch_id,
          excluded_binding_ids: ["builder-a"],
        },
      },
    });
    assert.equal(claimed.binding_id, "builder-b");
    assert.equal(claimed.attempt_number, 2);
    const foOk = store
      .listEvents()
      .filter(
        (e) =>
          e.event_type === "cycle.failover_selected" &&
          (e.payload as { dispatch_id?: string }).dispatch_id ===
            claimed.dispatch_id,
      );
    assert.equal(foOk.length, 1);

    // Injected failure before COMMIT
    const beforeN = (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM dispatches WHERE request_id = ?`)
        .get(reqId) as { n: number }
    ).n;
    const beforeEv = store.listEvents().length;
    const origAppend = store.appendEvent.bind(store);
    store.appendEvent = ((eventType, args) => {
      if (eventType === "cycle.failover_selected") {
        throw new Error("inject fail before failover_selected commit");
      }
      return origAppend(eventType, args);
    }) as typeof store.appendEvent;

    assert.throws(() =>
      handoff.claimDispatch({
        cycleId: cycle.cycle_id,
        requestId: reqId,
        targetRole: "builder",
        owner: "owner",
        leaseMs: 60_000,
        bindingId: "builder-c",
        coupledEvent: {
          eventType: "cycle.failover_selected",
          project_id: project.project_id,
          work_id: null,
          payload: {
            cycle_id: cycle.cycle_id,
            request_id: reqId,
            binding_id: "builder-c",
          },
        },
      }),
    );
    store.appendEvent = origAppend;
    const afterN = (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM dispatches WHERE request_id = ?`)
        .get(reqId) as { n: number }
    ).n;
    assert.equal(afterN, beforeN);
    assert.equal(store.listEvents().length, beforeEv);
    assert.equal(
      store.listEvents().filter((e) => e.event_type === "cycle.failover_selected")
        .length,
      1,
    );
  } finally {
    cleanup(dir);
  }
});

test("S13: preclaim routing block does not emit failover_selected", async () => {
  const dir = tempState();
  try {
    const { store, handoff, envClock } = openHarness(dir);
    const project = store.createProject("s13-preclaim");
    const cycle = handoff.createCycle({
      projectId: project.project_id,
      workPackageRef: "WP-004",
      baseSha: "base",
    });
    const pc = new FakeProgramControlAdapter(
      [
        pcDecision({
          decision: "BUILD",
          install_policy: { on_builder_candidate: "AWAIT_PC" },
        }),
      ],
      envClock,
    );
    const builderA = new FakeBuilderAdapter([], envClock);
    const reviewer = new FakeReviewerAdapter([], envClock);
    const registry = multiBuilderRegistry();
    const catalog: RuntimeCatalogEntry[] = [
      {
        binding_id: "pc-main",
        role: "program_control",
        adapter: pc,
        probe: available(),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-a",
        role: "builder",
        adapter: builderA,
        probe: unavailable("agent"),
        costProbe: costWithin(),
      },
      {
        binding_id: "builder-b",
        role: "builder",
        adapter: builderA,
        probe: unavailable("cred"),
        costProbe: costWithin(),
      },
      {
        binding_id: "reviewer-main",
        role: "reviewer",
        adapter: reviewer,
        probe: available(),
        costProbe: costWithin(),
      },
    ];
    const dispatcher = new Dispatcher(
      handoff,
      { programControl: pc, builder: builderA, reviewer },
      {
        owner: "disp",
        leaseMs: 60_000,
        routing: {
          registry,
          catalog,
          costConstraint: TEST_COST_CONSTRAINT,
          failoverPolicy: { mode: "FENCED" },
        },
      },
    );
    let last = await dispatcher.step(cycle.cycle_id);
    while (
      last.cycle.state !== "RECOVERY_REQUIRED" &&
      last.action !== "routing_blocked"
    ) {
      last = await dispatcher.step(cycle.cycle_id);
      if (last.action === "routing_blocked") break;
    }
    assert.equal(last.action, "routing_blocked");
    assert.equal(
      handoff.store.listEvents().filter((e) => e.event_type === "cycle.failover_selected")
        .length,
      0,
    );
    const builds = handoff.store.db
      .prepare(`SELECT COUNT(*) AS n FROM dispatches WHERE target_role='builder'`)
      .get() as { n: number };
    assert.equal(Number(builds.n), 0);
  } finally {
    cleanup(dir);
  }
});
