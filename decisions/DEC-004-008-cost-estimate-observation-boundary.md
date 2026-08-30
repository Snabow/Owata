# DEC-004-008 — Cost Estimate Observation Boundary (WP-004-S7)

**ID:** DEC-004-008
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S7
**Authority:** Program Control (OWATA-REQ-0102; invariant repair OWATA-REQ-0103)
**Related:** `decisions/DEC-004-002-availability-boundary.md`, `decisions/DEC-004-007-quota-observation-boundary.md`, `decisions/DEC-004-006-human-routine-approval-zero.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S1–S6 delivered registry eligibility, availability, selection, durable attribution, routed cutover, and quota observation without live quota routing. Phase 4 still lacks a truthful provider-neutral cost estimate substrate. There is currently no live provider cost substrate in OWATA; S7 introduces observation + deterministic assessment only. Do not invent price tables, token pricing, currency conversion, or billing reconciliation.

---

## Program Control adjudications

### A-013 — Two-state cost estimate observation

Cost is observed **per `binding_id`**, not per provider/model as architecture.

Exact states:

| State | Meaning |
| --- | --- |
| `ESTIMATE_AVAILABLE` | an explicit adapter/provider-owned probe supplied a syntactically valid next-invocation estimate |
| `UNKNOWN` | OWATA cannot truthfully determine a next-invocation cost estimate |

`UNKNOWN` MUST NOT mean zero, free, included, prepaid, unlimited, expensive, or cheap.

Minimal estimate shape:

```text
CostEstimate { amount_decimal: string; currency_code: string }
```

Rules:

- `amount_decimal`: non-negative base-10 decimal string (examples `"0"`, `"0.01"`, `"12.5"`); no sign; no exponent; no NaN/Infinity; no float arithmetic
- `currency_code`: exactly three uppercase ASCII letters; syntactic validation only; no ISO currency table; no conversion
- `"0"` is valid **only** when explicitly supplied by the probe — never inferred from subscription, successful invocation, local CLI, absence of billing error, or provider/model identity
- Malformed probe payloads fail safe → `UNKNOWN` (do not clamp, uppercase currencies, round, strip units, parse prose, or derive from tokens)

### A-014 — Deterministic assessment; descriptive only; no ranking

`assessCost(bindings, observations)` partitions input bindings into `estimated` / `unknown`, preserving exact input binding order in each partition and in the resolved `observations` list.

Rules:

- Missing observation for an input binding → `UNKNOWN`
- Within one assessment, observation identity is **unique by `binding_id`**. Duplicate `binding_id` observations fail closed with `RouterError` code `COST_INVALID`. No first-wins / last-wins / merge
- Observations whose `binding_id` is **absent from the input binding list are ignored** — they cannot inject a binding into any partition
- Partitions are **descriptive only** — no cheapest selection, no currency conversion, no amount sorting, no LOW/MEDIUM/HIGH, no thresholds, no spend authorization

Normalized `CostObservation` invariant (distinct from raw probe normalization):

- `ESTIMATE_AVAILABLE` → syntactically valid `estimate` required
- Contradictory/malformed normalized observations fail closed with `COST_INVALID`
- Raw malformed probe payload: `normalizeCostEstimate` → `UNKNOWN`

These are intentionally distinct boundaries.

S7 does **not** map cost partitions to Control Core `FailureClass`, and does **not** change `selectBinding` / Dispatcher selection.

### A-015 — Ephemeral; no live cost routing; Human cost authority unchanged

S7 is API + tests only.

- No wire into live `selectBinding`, Dispatcher, Gateway, canary, or model-policy
- No registry / SQLite / SCHEMA_VERSION change; no cost columns or cost events
- Observations are **ephemeral**
- Probe exceptions classify as `UNKNOWN` (no retry)
- Cost estimate ≠ actual charge ≠ quota ≠ availability ≠ retry budget ≠ Human-approved cost ceiling ≠ authorization to spend
- A cost estimate is evidence, not spending permission; it does not raise a Human-approved cost ceiling, authorize paid invocation/purchase/charging, or suppress an existing cost Human Gate
- Any future policy that changes a material cost ceiling or authorizes new external charging remains a Human Gate under DEC-004-006
- Cost routing policy / composition, actual cost accounting, automatic escalation, and failover remain deferred
- Quota routing policy remains deferred

---

## Decision

Pipeline addition (offline / pure):

```text
bindings + CostObservation[]
→ assessCost()
→ { estimated, unknown, observations }
```

Normalize helpers:

- `normalizeCostEstimate(bindingId, probe|null|undefined)`
- `observeBindingCost(bindingId, probeFn)` — exception → `UNKNOWN`

### Non-goals for S7

- No live cost-aware routing / cutover behavior change
- No provider price tables / token-price calculations
- No currency conversion / billing reconciliation / subscription allocation
- No ranking or cheapest selection
- No automatic escalation / failover under fencing
- No FailureClass mapping
- No SQLite schema; observations ephemeral
- No static price/cost fields on ProviderBinding
- No real model invocations in this slice

---

## Consequences

Later slices may consume `assessCost` partitions when Program Control authorizes a cost routing policy. S7 itself does not choose or apply that policy. Material cost ceilings remain Human Gate.
