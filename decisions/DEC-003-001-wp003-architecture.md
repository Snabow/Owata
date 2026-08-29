# DEC-003-001 — WP-003 Architecture

**ID:** DEC-003-001
**Status:** ACCEPTED
**Date:** 2026-08-29
**Work Package:** WP-003
**Baseline:** `main @ 2b105800dc18879b789b3d05dec3f6fca52f219d`
**Authority:** Program Control (OWATA-REQ-0020)
**Charter:** `Project-OWATA-Genesis-Charter.md` — Phase 3 Role / Provider Separation

Convention: architecture decisions live in `decisions/DEC-<wp>-<seq>-<slug>.md`. Status is `PROPOSED` | `ACCEPTED` | `SUPERSEDED`. Chat history is not a Decision.

---

## Context

WP-002 is DONE and merged to `main` at `2b105800dc18879b789b3d05dec3f6fca52f219d`. Independent Review of the final candidate was PASS. All WP-002 findings are resolved.

The next Genesis bottleneck is **Human Clipboard**: Humans still copy structured intent and results between Program Control, Builder, and Independent Reviewer, and still start the next role by hand.

Charter Phase 3 requires role/provider separation with formal artifacts only. This Decision adopts the core of the WP-003 design proposal with Program Control corrections. It is documentation of approved architecture. It does not implement runtime behavior.

---

## Decision

Use **SQLite-authoritative structured-envelope dispatch** with a **deterministic, provider-neutral Dispatcher** and **replaceable role adapters**.

### Workflow authority

- SQLite remains the authoritative workflow / runtime / cycle / handoff state.
- Git remains authoritative for implementation artifacts, source, candidate SHA, Work Package documents, decisions, and durable evidence.
- GitHub is remote Git / evidence durability and may later provide collaboration surfaces.
- GitHub MUST NOT become a second authoritative workflow queue in WP-003.

### Structured handoff

- Canonical inter-role communication uses versioned, machine-oriented structured envelopes.
- Natural-language prompts are provider-adapter outputs, not canonical handoff state.
- Minimum logical envelope families: Control Request, Role Result, Program Control Decision, Human Gate / Human Gate Response.
- Exact field schema is deferred to the first coding slice.

### Deterministic Dispatcher

The Dispatcher may persist validated envelopes, inspect deterministic state, execute predefined transitions, perform capability preflight, invoke configured adapters, enforce leases / fencing / idempotency / retry budgets, capture results, and resume interrupted work.

The Dispatcher MUST NOT originate Program Control decisions, adjudicate Reviewer findings, decide REWORK scope, approve Builder output, suppress or rewrite Reviewer findings, silently change project architecture, or choose Human-impacting outcomes.

Meaningful next-action decisions remain Program Control authority.

### Role adapters

Core exposes provider-neutral logical boundaries:

- `ProgramControlAdapter`
- `BuilderAdapter`
- `ReviewerAdapter`

Provider / model / runtime bindings remain replaceable. Do not encode ChatGPT, Cursor, Codex, Claude, ACP, OpenHands, or other provider names into Control Core state-machine semantics.

### Program Control provider — no change yet

Do **not** adopt “Program Control = `codex exec`” as an architectural decision.

The Program Control adapter binding remains unresolved until real adapter integration.

WP-003 Slice 1 uses fake adapters and therefore requires no Program Control provider decision.

Current logical Champion remains Program Control = ChatGPT until separately changed by Program Control Decision.

### Builder and Reviewer Champions

Current logical Champion remains Builder = Cursor. Headless Cursor capability may be evaluated when the real Builder adapter slice begins. Do not install or integrate it in this Decision’s accompanying request.

Current logical Champion remains Independent Reviewer = Codex. Exact candidate SHA, isolated / disposable review workspace, no Builder conversation history, no Reviewer source modification, and Program Control adjudication remain required trust-boundary semantics.

### Runtime Operator is not a decision role

Do not create a new AI decision role called Runtime Operator.

Runtime / operator mechanics are implementation concerns behind the deterministic Dispatcher / adapters. An implementation runtime may transport or invoke roles but receives no Program Control authority.

### Session may exist, but session is never authoritative

Do not encode “sessions do not exist.”

Agent / provider sessions may be created, reused, resumed, discarded, or replaced. Correctness and project continuity must survive loss of every agent session. A replacement runtime reconstructs required context from SQLite durable state, Git, structured envelopes, and Work Package / Decision / Evidence records.

B1/B2-style session labels are Genesis scaffolding only.

### Capability / resource preflight

WP-003 introduces the minimum capability / resource preflight needed to avoid assigning work to an incapable runtime.

The first protocol should be able to express requirements such as `repository_read`, `repository_write`, `exact_checkout`, `command_execution`, `dependency_install` where applicable, and network access where applicable.

Credential values MUST NOT enter Git, envelopes, or event logs.

Failure should be classified before execution where possible (`CAPABILITY_BLOCK`, `AGENT_UNAVAILABLE`, `REPO_UNAVAILABLE`, `CREDENTIAL_UNAVAILABLE`, `RUNTIME_ERROR`, `RESULT_INVALID`, `RESULT_STALE`, or product / work failure).

Do not implement generalized provider routing in WP-003.

### Failure semantics — return to Program Control

Do **not** define “rework budget exhausted → terminal FAILED” automatically.

Genesis Charter remains authoritative: Failure is State, not Terminal.

When bounded automatic recovery is exhausted, control returns to Program Control. Program Control may choose RETRY, bounded REWORK, REDESIGN, change runtime / provider when available, HUMAN_GATE, or ABORT.

Terminal project / work failure requires an explicit semantic terminal decision such as Program Control ABORT, not merely exhaustion of an arbitrary retry counter.

### Builder replay requires attempt isolation / fencing

Do not assume at-least-once Builder invocation is automatically safe. An LLM Builder may produce different effects on replay.

WP-003 must eventually isolate Builder dispatch attempts so stale attempts cannot become canonical results, fenced ownership controls result acceptance, exact candidate SHA identifies accepted output, and an old attempt finishing late cannot overwrite the active candidate. Attempt-specific worktree / branch isolation is preferred.

Detailed implementation belongs in later WP-003 slices.

### Automatic review requires durable Program Control policy

Automatic Builder-candidate → Reviewer dispatch is allowed only as execution of previously durable Program Control policy / decision.

The Dispatcher does not independently decide that review should occur.

The cycle may carry a standing transition policy such as `on_builder_candidate = DISPATCH_REVIEW`, provided that policy was produced / approved by Program Control and persisted durably.

### ACP is Challenger only

Do not adopt ACP or OpenHands in the first WP-003 implementation.

Record ACP as the single current Challenger for future adapter transport evaluation.

The first Champion should prove OWATA semantics with the smallest local implementation.

### Human Clipboard Zero

WP-003’s central completion condition is one complete Program Control → Builder → Independent Reviewer → Program Control cycle without Human copy/paste, manual agent invocation, manual role routing, or manual session switching.

The acceptance canary should include at least one Reviewer REWORK path before PASS.

Human involvement is allowed only at an intentional Human Gate.

### Current CLI status is not authoritative

Current `owata status` remains a WP-000 bootstrap stub (`State: Genesis` / `Next: Bootstrap control core`). It is not Source of Truth for project status. A durable-state-backed status view belongs to WP-003 or a later appropriate slice.

---

## Consequences

### Enables

- A fresh agent can reconstruct that WP-002 is complete, why WP-003 exists, and which architecture is already approved.
- Slice 1 can implement protocol, durable cycle state, Dispatcher, and fake adapters without resolving provider bindings.
- Provider products can later change without rewriting Control Core semantics.
- Session loss is a recoverable runtime event, not loss of project truth.
- Exhausted local recovery returns to Program Control instead of silently terminating the project.
- GitHub remains evidence durability, not a competing queue.

### Deferred

- Exact envelope field schema
- Schema v5, Dispatcher implementation, real adapters, CLI integration
- Program Control provider binding
- Headless Cursor / real Builder adapter
- Real Reviewer adapter
- ACP transport evaluation
- Generalized routing
- Durable-state-backed `owata status`
- Detailed Builder attempt isolation (required eventually; not Slice 1’s entire surface)

### Does not change

- WP-002 merged history or local worker-loop `FAILED` semantics for deterministic proving samples
- Current logical Champions until a later Program Control Decision
- Charter rule that Reviewer findings are adjudicated by Program Control
