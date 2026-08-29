import {
  defaultPreflight,
  type AdapterIdentity,
  type BuilderAdapter,
  type BuilderInput,
  type PreflightResult,
  type ProgramControlAdapter,
  type ProgramControlInput,
  type ReviewerAdapter,
  type ReviewerInput,
} from "../adapters.js";
import {
  PROTOCOL_V1,
  type Capability,
  type Finding,
  type PcDecisionBody,
  type ReviewerVerdict,
} from "../protocol.js";

export interface EnvelopeClock {
  id(prefix?: string): string;
  now(): string;
}

export class FakeProgramControlAdapter implements ProgramControlAdapter {
  readonly identity: AdapterIdentity = {
    adapter_id: "fake-program-control",
    role: "program_control",
  };
  invocations = 0;
  caps: Capability[];
  private readonly script: PcDecisionBody[];
  private readonly clock: EnvelopeClock;

  constructor(script: PcDecisionBody[], clock: EnvelopeClock, caps?: Capability[]) {
    this.script = script;
    this.clock = clock;
    this.caps = caps ?? ["repository_read"];
  }

  capabilities(): Capability[] {
    return this.caps;
  }

  preflight(required: Capability[]): PreflightResult {
    return defaultPreflight(this.caps, required);
  }

  decide(input: ProgramControlInput): unknown {
    this.invocations += 1;
    const body = this.script[this.invocations - 1];
    if (!body) {
      throw new Error("Fake Program Control script exhausted");
    }
    return {
      protocol: PROTOCOL_V1,
      envelope_id: this.clock.id("env"),
      kind: "program_control_decision",
      cycle_id: input.cycle.cycle_id,
      request_id: input.cycle.current_request_id,
      from_role: "program_control",
      to_role: "dispatcher",
      created_at: this.clock.now(),
      body,
    };
  }
}

export class FakeBuilderAdapter implements BuilderAdapter {
  readonly identity: AdapterIdentity = {
    adapter_id: "fake-builder",
    role: "builder",
  };
  invocations = 0;
  caps: Capability[];
  private readonly script: Array<
    | { status: "CANDIDATE_READY"; candidate_sha: string }
    | { status: "BLOCKED" | "FAILED"; notes?: string }
    | { invalid: true }
  >;
  private readonly clock: EnvelopeClock;

  constructor(
    script: FakeBuilderAdapter["script"],
    clock: EnvelopeClock,
    caps?: Capability[],
  ) {
    this.script = script;
    this.clock = clock;
    this.caps = caps ?? [
      "repository_read",
      "repository_write",
      "exact_checkout",
      "command_execution",
    ];
  }

  capabilities(): Capability[] {
    return this.caps;
  }

  preflight(required: Capability[]): PreflightResult {
    return defaultPreflight(this.caps, required);
  }

  build(input: BuilderInput): unknown {
    this.invocations += 1;
    const next = this.script[this.invocations - 1];
    if (!next) {
      throw new Error("Fake Builder script exhausted");
    }
    if ("invalid" in next) {
      return { not: "an-envelope" };
    }
    return {
      protocol: PROTOCOL_V1,
      envelope_id: this.clock.id("env"),
      kind: "builder_result",
      cycle_id: input.cycle.cycle_id,
      request_id: input.request.request_id,
      from_role: "builder",
      to_role: "program_control",
      created_at: this.clock.now(),
      body: {
        status: next.status,
        candidate_sha: next.status === "CANDIDATE_READY" ? next.candidate_sha : null,
        evidence_refs: [`evidence/fake-${this.invocations}`],
        notes: "status" in next && next.status !== "CANDIDATE_READY" ? next.notes ?? null : null,
      },
    };
  }
}

export class FakeReviewerAdapter implements ReviewerAdapter {
  readonly identity: AdapterIdentity = {
    adapter_id: "fake-reviewer",
    role: "reviewer",
  };
  invocations = 0;
  caps: Capability[];
  private readonly script: Array<{
    verdict: ReviewerVerdict;
    findings?: Finding[];
    target_sha?: string;
    invalid?: boolean;
  }>;
  private readonly clock: EnvelopeClock;

  constructor(
    script: FakeReviewerAdapter["script"],
    clock: EnvelopeClock,
    caps?: Capability[],
  ) {
    this.script = script;
    this.clock = clock;
    this.caps = caps ?? [
      "repository_read",
      "exact_checkout",
      "command_execution",
    ];
  }

  capabilities(): Capability[] {
    return this.caps;
  }

  preflight(required: Capability[]): PreflightResult {
    return defaultPreflight(this.caps, required);
  }

  review(input: ReviewerInput): unknown {
    this.invocations += 1;
    const next = this.script[this.invocations - 1];
    if (!next) {
      throw new Error("Fake Reviewer script exhausted");
    }
    if (next.invalid) {
      return "not-json-object";
    }
    return {
      protocol: PROTOCOL_V1,
      envelope_id: this.clock.id("env"),
      kind: "reviewer_result",
      cycle_id: input.cycle.cycle_id,
      request_id: input.request.request_id,
      from_role: "reviewer",
      to_role: "program_control",
      created_at: this.clock.now(),
      body: {
        target_sha: next.target_sha ?? input.request.body.target_sha ?? "missing",
        verdict: next.verdict,
        findings: next.findings ?? [],
        evidence_refs: [`evidence/review-${this.invocations}`],
      },
    };
  }
}
