# DEC-004-011 — Cost Routing Constraint + Pure Composition (WP-004-S10)

**ID:** DEC-004-011
**Status:** ACCEPTED
**Date:** 2026-08-31
**Work Package:** WP-004-S10
**Authority:** Program Control (OWATA-REQ-0123)
**Related:** `decisions/DEC-004-008-cost-estimate-observation-boundary.md`, `decisions/DEC-004-009-quota-routing-policy.md`, `decisions/DEC-004-006-human-routine-approval-zero.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S7 delivered cost estimate observation without routing. S8/S9 delivered quota policy and live quota cutover. S10 defines the first explicit **cost constraint** policy as a pure composition API after eligibility / availability / quota ordering, without live Dispatcher wiring or spend authorization.

---

## Program Control adjudications

### A-022 — Cost routing constraint

`CostRoutingConstraint = { max_estimate: CostEstimate }` using the exact accepted S7 `CostEstimate` syntax and `isValidCostEstimate` validator.

Invalid constraint → `RouterError` `COST_INVALID` (no repair).

The constraint is **input only**: the API does not approve, change, or authorize it. Material cost ceiling changes / new external charging remain Human Gate under DEC-004-006 / DEC-004-008.

### A-023 — Exact decimal comparison

`compareDecimalAmounts(a, b) → -1 | 0 | 1` on canonical `amount_decimal` strings.

No `Number` / `parseFloat` / floating-point arithmetic / exponent conversion.

Equal forms such as `0`/`0.0`, `0.1`/`0.10`, `12.5`/`12.500` compare equal. Huge integers compare without precision loss.

### A-024 — Cost constraint assessment

`applyCostRoutingConstraint(bindings, costObservations, constraint)` partitions (input order preserved):

| Partition | Meaning |
| --- | --- |
| `WITHIN_CEILING` | same currency and amount ≤ ceiling |
| `OVER_CEILING` | same currency and amount > ceiling |
| `UNKNOWN` | cost UNKNOWN |
| `CURRENCY_MISMATCH` | ESTIMATE_AVAILABLE with different currency |

No currency conversion. No ranking. Composes `assessCost` for normalized observation validation (S7 fail-closed rules).

`WITHIN_CEILING` means only: next-invocation estimate ≤ supplied estimate ceiling. It is **not** actual-charge guarantee, authorized spend, free, or billing proof.

### A-025 — Pure quota + cost composition

`selectBindingWithQuotaAndCost(...)`:

```text
ProviderRegistry
→ S1 eligibility
→ S2 availability
→ S8 quota order (AVAILABLE then UNKNOWN; EXHAUSTED excluded)
→ S10 cost WITHIN_CEILING filter (preserve quota-aware order)
→ CostAwareBindingSelectionResult
```

Within cost-WITHIN candidates: **do not** choose cheapest; preserve quota-aware order.

SELECTED exposes `quota_state` + `estimate` (`cost_state: ESTIMATE_AVAILABLE`). No selected UNKNOWN cost.

Upstream: `NO_ELIGIBLE_BINDING` / `NO_AVAILABLE_BINDING` / `NO_QUOTA_ROUTABLE_BINDING` / `NO_COST_VERIFIABLE_BINDING`.

`selectBinding()` and `selectBindingWithQuota()` unchanged. Live S9 Dispatcher unchanged. `ACTIVE_COST_ROUTING=NO`.

---

## Decision

Pipeline addition (offline / pure):

```text
registry + request + availabilityObs + quotaObs + costObs + constraint
→ selectBindingWithQuotaAndCost()
→ SELECTED{binding,quota_state,estimate} | NO_* outcomes
```

### Non-goals for S10

- No live cost Dispatcher cutover / costProbe catalog
- No cheapest ranking / currency conversion / price tables
- No automatic escalation / failover
- No actual cost accounting / spend authorization
- No SQLite / SCHEMA_VERSION change

---

## Consequences

Later slices may wire this pure policy into live routing when Program Control authorizes cutover and Human cost authority predicates remain satisfied.
