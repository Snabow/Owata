# DEC-004-003 — Binding Selection Boundary (WP-004-S3)

**ID:** DEC-004-003
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S3
**Authority:** Program Control (OWATA-REQ-0081)
**Related:** `decisions/DEC-004-001-router-s1-boundary.md`, `decisions/DEC-004-002-availability-boundary.md`
**Provenance audit:** `evidence/wp-004-post-s2-audit.md` (OWATA-REQ-0080)

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S1 delivers an ordered eligible set. S2 overlays ephemeral availability. Neither selects a single binding. Post-S2 audit (OWATA-REQ-0080) identified deterministic selection as the smallest unlock before quota, cost, cutover, escalation, or failover.

---

## Program Control adjudications

### A-004 — Selection rule

S3 may select exactly one binding as a **pure API** result.

```text
SELECTED = first AVAILABLE binding in exact S1 order
```

S1 order remains: `priority ASC`, then `binding_id ASC`.

This is selection computation only. It does not invoke or dispatch the binding.

### A-005 — API-only

S3 is API + tests only.

`ACTIVE_RUNTIME_CUTOVER: NO`

No Dispatcher / Gateway / canary product path may consume S3 yet.

### A-006 — FailureClass mapping deferred

Keep Router outcomes Router-native in S3.

Do not map `NO_ELIGIBLE_BINDING`, `NO_AVAILABLE_BINDING`, `CREDENTIAL_UNAVAILABLE`, `AGENT_UNAVAILABLE`, or `UNKNOWN` to Control Core `FailureClass` yet.

FailureClass mapping belongs to later active routing integration.

### A-007 — Durable binding_id deferred

Durable selected `binding_id` attribution is required before failover can be accepted.

However: `DURABLE_BINDING_ID: DEFERRED`, `SQLITE_SCHEMA_CHANGED: NO`.

S3 remains pure and non-durable.

### A-008 — adapter_id vs binding_id

Gateway `adapter_id` and Router registry `binding_id` remain distinct identities.

Do not redefine `adapter_id` as `binding_id`. Future cutover must record `binding_id` separately.

---

## Decision

Pipeline:

```text
ProviderRegistry
→ filterEligibleBindings()
→ overlayAvailability()
→ SELECTED | NO_ELIGIBLE_BINDING | NO_AVAILABLE_BINDING
```

If S2 returns `AVAILABLE`, selected binding is exactly index 0 of the S2 AVAILABLE bindings. Do not re-sort independently.

### Non-goals for S3

- No active Dispatcher/Gateway/canary cutover
- No FailureClass mapping
- No durable `binding_id` / SQLite / event log
- No quota / cost / automatic escalation / failover
- No Program Control semantic decisions (`BUILD` / `REWORK` / `ACCEPT` / `HUMAN_GATE` / …)
- No model-policy embedding (A-002)

---

## Consequences

Later slices may consume `selectBinding` for cutover, then attach durable binding identity, FailureClass mapping, quota/cost overlays, escalation, and failover — in that dependency order unless Program Control re-adjudicates.
