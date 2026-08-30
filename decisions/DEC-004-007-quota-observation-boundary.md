# DEC-004-007 — Quota Observation Boundary (WP-004-S6)

**ID:** DEC-004-007
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S6
**Authority:** Program Control (OWATA-REQ-0095; wording repair OWATA-REQ-0097)
**Related:** `decisions/DEC-004-002-availability-boundary.md`, `decisions/DEC-004-003-selection-boundary.md`, `decisions/DEC-004-005-routed-dispatch-cutover.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S1–S5 delivered registry eligibility, availability overlay, deterministic selection, durable `binding_id` attribution, and active routed Dispatcher cutover without automatic failover. Phase 4 still lacks a provider-neutral quota observation substrate. Post-S2 audit established product quota as ABSENT; S6 introduces observation + deterministic assessment only.

---

## Program Control adjudications

### A-010 — Three-state quota observation

Quota is observed **per `binding_id`**, not per provider/model as architecture.

Exact states:

| State | Meaning |
| --- | --- |
| `AVAILABLE` | `probe.exhausted === false` |
| `EXHAUSTED` | `probe.exhausted === true` |
| `UNKNOWN` | no current observation, null/undefined probe, or probe exception |

Probe shape is structural and minimal:

```text
QuotaProbeResult { exhausted: boolean; detail?: string }
```

Do **not** invent `remaining_tokens`, prices, plans, rate windows, or comparable numeric budgets in S6.

`UNKNOWN` is a **distinct factual quota state**. S6 MUST NOT normalize or reclassify `UNKNOWN` as `AVAILABLE`, `EXHAUSTED`, unlimited, or zero quota.

S6 does **not** decide whether `UNKNOWN` is routable. S6 does **not** decide whether a future Router should retain the binding, skip it, probe again, block, retry, escalate, or fail over. Those behaviors belong to a future quota routing policy slice (deferred).

### A-011 — Deterministic assessment + observation uniqueness

`assessQuota(bindings, observations)` partitions input bindings into `available` / `exhausted` / `unknown`, preserving exact input binding order in each partition and in the resolved `observations` list. Placing observations in the `unknown` partition is **descriptive only** and carries no routing permission or prohibition.

Rules:

- Missing observation for an input binding → `UNKNOWN`
- Within one assessment, observation identity is **unique by `binding_id`**. Duplicate `binding_id` observations (identical or conflicting) fail closed with `RouterError` code `QUOTA_INVALID`. No first-wins / last-wins / merge.
- Observations whose `binding_id` is **absent from the input binding list are ignored** — they cannot inject a binding into any partition. (Documented preference: ignore unrelated observations rather than fail the whole assessment solely because an unused id is present.)

S6 does **not** map quota partitions to Control Core `FailureClass`, and does **not** change `selectBinding` / Dispatcher selection.

### A-012 — Observation-only; no live quota routing

S6 is API + tests only.

- No wire into live `selectBinding`, Dispatcher, Gateway, canary, or model-policy
- No registry / SQLite / SCHEMA_VERSION change
- Observations are **ephemeral**
- Probe exceptions classify as `UNKNOWN` (no retry)
- Quota routing policy (skip exhausted, prefer available, etc.) is **deferred**
- Cost / automatic escalation / failover remain deferred

---

## Decision

Pipeline addition (offline / pure):

```text
bindings + QuotaObservation[]
→ assessQuota()
→ { available, exhausted, unknown, observations }
```

Normalize helpers mirror S2 availability style:

- `normalizeQuota(bindingId, probe|null|undefined)`
- `observeBindingQuota(bindingId, probeFn)` — exception → `UNKNOWN`

### Non-goals for S6

- No live routing change / cutover behavior change
- No remaining_tokens / prices / plans / rate windows
- No cost accounting
- No automatic escalation
- No failover under fencing
- No FailureClass mapping
- No SQLite schema; observations ephemeral
- No provider-specific branching
- No model-policy embedding (A-002)

---

## Consequences

Later slices may consume `assessQuota` partitions when Program Control authorizes a quota routing policy. S6 itself does not choose or apply that policy.
