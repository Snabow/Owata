# DEC-004-013 — Automatic Escalation (WP-004-S12)

**ID:** DEC-004-013
**Status:** IMPLEMENTED (pending Independent Review / Program Control acceptance)
**Date:** 2026-08-31
**Work Package:** WP-004-S12
**Authority:** Program Control (OWATA-REQ-0137)
**Related:** `decisions/DEC-004-012-live-cost-routing-cutover.md`, `decisions/DEC-004-010-live-quota-routing-cutover.md`, `decisions/DEC-004-005-routed-dispatch-cutover.md`, `decisions/DEC-004-006-human-routine-approval-zero.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S11 activated live cost routing on the S9 path while keeping same-request pin and CLAIMED-lease fencing. S12 formalizes **automatic escalation** as pre-attribution evidence: when already-accepted availability/quota/cost routing selects a later eligible binding than the exact S1 first preferred candidate. S8/S10/S11 winner semantics are unchanged. Automatic failover remains deferred.

---

## Program Control adjudications

### A-031 — Automatic escalation definition

Automatic escalation = **PRE-ATTRIBUTION** advancement from the first S1-preferred eligible binding to a later binding selected by already-accepted live routing (eligibility → availability → quota → cost → selection).

Applies only while the request has **no** durable binding attribution. It is **not** post-failure failover.

For an unattributed request:

1. Compute exact S1 eligible binding order
2. `baseline` = first eligible binding
3. Run accepted live routing
4. If selected == baseline → `AUTOMATIC_ESCALATION = NO` / state `PRIMARY`
5. If selected != baseline → `AUTOMATIC_ESCALATION = YES` / state `ESCALATED`

The later selected binding must already be permitted by existing policy. Do **not** change S8/S10/S11 winner semantics.

### A-032 — MUST NOT (no semantic escalation)

Preserve the same `request_id`, role, `required_capabilities`, `base_sha` / `target_sha`, authorized findings, `costConstraint`, and Human cost authority.

MUST NOT:

- increase ceiling
- change currency
- infer ceiling
- relax / add capabilities
- change role / WP meaning
- select outside the registry
- infer a stronger model from names
- modify registry priority
- create quality tiers

No semantic escalation.

### A-033 — Versus failover

S12 only: **UNATTRIBUTED → later candidate → claim once → invoke**.

Preserve `AUTOMATIC_FAILOVER=NO`.

- After attribution: **NO** alternate
- Pinned request: **NO** escalation
- CLAIMED lease: **NO** escalation
- Preflight contradiction: fail closed, **NO** reselection
- Runtime failure after claim: existing recovery only, **NO** alternate

### A-034 — Evidence surface

Type: `AutomaticEscalationState = "PRIMARY" | "ESCALATED"`.

Initial `SELECTED` exposes:

- `baseline_binding_id`
- `selected_binding_id`
- `automatic_escalation` (`PRIMARY` | `ESCALATED`)

No quality labels (`"stronger"` / `"premium"` / `"better"`).

After successful **NEW** initial binding claim, append durable `cycle.routing_selected` with sanitized payload including: `cycle_id`, `request_id`, `dispatch_id`, `target_role`, `binding_id`, `baseline_binding_id`, `automatic_escalation` (boolean), `required_capabilities`, `observations`, `quota_observations`, `cost_observations`, `cost_constraint` (sanitized snapshot). Only after successful claim. No event if claim failed. Existing `cycle.dispatch_claimed` remains authoritative for attribution.

**Atomicity (OWATA-REQ-0139 / OWATA-REQ-0138-F001):** `cycle.routing_selected` is committed inside the same `ControlStore.runImmediate()` success transaction as the new CLAIMED dispatch row, optional prior-CLAIMED recovery bookkeeping, and `cycle.dispatch_claimed` (via optional `claimDispatch({ coupledEvent })`). A failure before COMMIT leaves none of that new claim durable state. `RETRY_BUDGET` / `enterRecovery` remain outside that success transaction so recovery stays durable.

Routing blocks unchanged; do not fabricate escalation on blocks. Schema remains v6. Provider registry / model-policy unchanged.

---

## Decision

`AUTOMATIC_ESCALATION=YES` with scope `PRE_ATTRIBUTION_ROUTING`. Escalation is evidence of already-permitted live routing selecting a later S1-eligible candidate before durable attribution. It does not authorize failover, ceiling changes, or quality tiers.

### Non-goals for S12

- Automatic failover / alternate-binding retry after attribution
- Registry priority / quality-tier / model-strength fields
- Raising or inferring cost ceilings for escalation
- Schema change / durable store beyond existing events
- Actual cost accounting / spend authorization

---

## Consequences

Phase 4 remaining after S12: failover under fencing (and actual cost accounting unless later acceptance requires it). Human cost authority predicates remain required for material ceiling / charging changes.
