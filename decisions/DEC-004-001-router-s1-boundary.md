# DEC-004-001 — Router S1 Boundary

**ID:** DEC-004-001
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S1
**Authority:** Program Control (OWATA-REQ-0070)
**Related:** `evidence/wp-004-entry-audit.md` (OWATA-REQ-0069)

Convention: architecture decisions live in `decisions/DEC-<wp>-<seq>-<slug>.md`. Status is `PROPOSED` | `ACCEPTED` | `SUPERSEDED`. Chat history is not a Decision.

Builder MUST NOT expand or change this Decision. It records Program Control adjudication of A-001..003 for WP-004-S1.

---

## Context

WP-003 closed Human Clipboard Zero. Phase 4 entry audit (OWATA-REQ-0069) recommended a first slice limited to Provider Registry + Capability Profile + deterministic eligibility filter. Ambiguous items A-001..003 required Program Control adjudication before implementation.

---

## Decision

### A-001 — Eligibility only

S1 MUST NOT choose or invoke one binding as a dispatch side effect.

S1 returns only:

- a deterministic ordered eligible binding set, or
- `NO_ELIGIBLE_BINDING`

Actual binding selection, invocation, and failover wiring are deferred.

### A-002 — Model policy stays external

Current non-Claude Builder/canary policy MUST NOT become:

- a provider capability
- a registry tag
- a universal router exclusion
- an architectural provider ban

Keep current `src/execution/model-policy.ts` unchanged and external to generic Router semantics. Future generalized provider/model restrictions belong to a separate routing-policy constraint layer.

### A-003 — Static authority is Git config

Static provider/runtime registry + capability profile authority for S1 is **Git-versioned configuration**.

Do NOT add SQLite tables/schema migration in S1.

Future dynamic observations (availability, quota, cost, routing decision evidence) may use durable SQLite state in later slices.

---

## Consequences

- Router S1 answers only: which configured bindings are statically eligible for a role/request.
- Router S1 is not Program Control and must not decide BUILD / REWORK / ACCEPT / RETRY / REDESIGN / HUMAN_GATE / ABORT.
- Active B2 runtime path remains unchanged until a later reviewed cutover slice.
