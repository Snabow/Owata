# DEC-003-003 — Real Builder Binding + B1 Session Replacement Canary

**ID:** DEC-003-003  
**Status:** ACCEPTED  
**Date:** 2026-08-29  
**Work Package:** WP-003  
**Authority:** Program Control — OWATA-REQ-0039  
**Challenger input (advisory only):** OWATA-REQ-0038 — Claude Fable 5 (`ACCEPT_WITH_CHANGES`). Fable had no project authority.  
**Related:** `DEC-003-001`, `DEC-003-002`

Convention: architecture decisions live in `decisions/DEC-<wp>-<seq>-<slug>.md`. Status is `PROPOSED` | `ACCEPTED` | `SUPERSEDED`. Chat history is not a Decision.

---

## Context

WP-003 Slice 1 proved durable structured handoff with fake adapters. Slice 2 binds a real Builder runtime behind the existing adapter boundary and proves session replacement from durable state alone.

---

## Decision

### A1 — Execution Gateway

**ACCEPT_WITH_REFINEMENT.**

Execution Gateway v1 is:

- stateless with respect to workflow authority
- behind existing Adapter interfaces
- no separate queue, Gateway DB, semantic project state, adjudication, or next-action authority

Implement as an in-process module for v1. Do **not** make "in-process forever" an architecture invariant; the provider-neutral execution contract must permit later replacement. SQLite remains sole workflow authority.

### A2 — B1 graduation scope

**ACCEPT.**

B1 does **not** require real Program Control or real Reviewer adapters. Slice 2 may use fake PC, fake Reviewer, and a REAL Builder binding.

B1 graduation requires: automatic real Builder launch, generated instructions from canonical request, structured result into durable state, and Session Replacement Canary (same durable request resumes under a fresh attempt/runtime with no Human continuity work).

Full PC → Builder → Reviewer → PC Human Clipboard Zero remains a later WP-003 completion requirement. Do **not** mark WP-003 DONE in Slice 2.

### A3 — Builder runtime contract v1

**ACCEPT_WITH_REFINEMENT.**

Introduce a provider-neutral `ExecutionBinding` (`probe` / `start` / `wait` / `cancel`). First Champion binding: Cursor CLI non-interactive/headless. Provider-specific argv stays outside Control Core semantics.

### A4 — Async execution + lease heartbeat

**ACCEPT.**

Adapter methods may return `Promise`. Dispatcher owns lease renewal for the claimed fence; heartbeat failure cancels the child runtime. Add `renewDispatchLease(dispatchId, fenceToken, leaseMs)`.

### A5 — Worktree per attempt

**ACCEPT — MANDATORY.**

Every real Builder attempt uses a fresh Core-managed Git worktree derived from durable attempt identity. Attempts must not share a writable checkout.

### A6 — Candidate Git reality

**ACCEPT — MANDATORY** before Builder result acceptance for real bindings.

Schema-valid `candidate_sha` is insufficient; verify resolvability, ancestry from `base_sha` when applicable, equality with the active attempt worktree HEAD, and clean tracked tree.

### A7 — Prompt / instruction compiler

**ACCEPT.**

Deterministic compiler from Control Request + durable cycle + pinned refs. Must not adjudicate findings, invent scope, or embed credentials. Record template version + `prompt_hash` as execution provenance.

### A8 — Capability / routing

**ACCEPT Fable recommendation to defer router.**

One static Builder binding. Collect telemetry only. Explicit non-Claude model required for the Cursor canary (no Auto). This restriction is execution policy, not universal Core semantics.

### A9 — Reviewer isolation

**ACCEPT AS FUTURE CONSTRAINT ONLY.**

Do not implement a real Reviewer adapter in Slice 2. Future Reviewer transport must be a sibling isolated binding, never Builder-session-mediated.

### Browser Relay disposition

**MODIFY Fable recommendation.**

Browser Relay remains temporarily active as OWATA **development** transport only. It is not Slice 2 product runtime, not project authority, not an Execution Gateway, and not evidence that Human Clipboard Zero is complete. Retire after a successful full-cycle no-relay canary.

### Non-Claude canary policy

Real Cursor Builder canary MUST use an explicitly selected non-Claude model. Prefer GPT-5.6 Sol when the runtime exposes a valid identifier; otherwise another verified non-Claude model. Do not guess. If unavailable → `HUMAN_GATE` / `NON_CLAUDE_BINDING_UNAVAILABLE`.

---

## Consequences

- Slice 2 implements Gateway-as-library, async+heartbeat, worktree isolation, prompt compiler, Git reality checks, Cursor CLI binding, and an opt-in real canary.
- Independent Review + Program Control alone may declare B1 graduated; Builder may only report `B1_CANARY_CANDIDATE`.
