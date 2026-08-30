# DEC-004-012 — Live Cost Routing Cutover (WP-004-S11)

**ID:** DEC-004-012
**Status:** ACCEPTED
**Date:** 2026-08-31
**Work Package:** WP-004-S11
**Authority:** Program Control (OWATA-REQ-0129)
**Related:** `decisions/DEC-004-010-live-quota-routing-cutover.md`, `decisions/DEC-004-011-cost-routing-policy.md`, `decisions/DEC-004-006-human-routine-approval-zero.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S10 defined pure `selectBindingWithQuotaAndCost` without live Dispatcher wiring. S11 activates that policy on the existing S9 routed path for **initial** binding selection while preserving same-request pinning and fencing. Mirrors S9 quota cutover pattern.

---

## Program Control adjudications

### A-026 — Mandatory live costConstraint

Active `RoutingConfig` MUST include `costConstraint: CostRoutingConstraint`.

- Missing / malformed → fail closed `ROUTING_CONFIG_INVALID` (`ControlError`)
- No default ceiling
- Reuses S10/S7 validation (`isValidCostEstimate` / cost-policy assert)
- Constraint is evaluation input only — not spend authorization; material ceiling changes remain Human Gate under DEC-004-006 / DEC-004-008

### A-027 — Optional live costProbe

`RuntimeCatalogEntry` may include optional `costProbe?: () => CostProbeResult | Promise<CostProbeResult>` (S7 shapes).

- Missing `costProbe` → cost state `UNKNOWN` via `observeBindingCost`
- Probe exception → `UNKNOWN`
- Malformed estimate → `UNKNOWN`
- No probe retry; no provider-specific branching

### A-028 — Live initial quota+cost selection

For a request with no prior attributed dispatch:

```text
ProviderRegistry → eligibility → availability observations
→ quota observations for availability-AVAILABLE only
→ cost observations for quota-routable only (AVAILABLE then UNKNOWN; EXHAUSTED no cost probe)
→ selectBindingWithQuotaAndCost (S10 policy) with config.costConstraint
→ catalog adapter → claimDispatch(binding_id) → invoke
```

SELECTED exposes `quota_state` + `cost_state: ESTIMATE_AVAILABLE` + `estimate`.
All quota-routable candidates non-verifiable under ceiling → Router block `NO_COST_VERIFIABLE_BINDING` (pre-claim; not failover).

### A-029 — Same-request pinning with cost

Prior non-null `binding_id` for the same `request_id`:

- Exact pin only; no multi-binding reselection
- Availability then quota then cost on pinned binding only
- Cost UNKNOWN / OVER_CEILING / CURRENCY_MISMATCH → `PINNED_BINDING_COST_NOT_VERIFIABLE` (never alternate binding)
- Prefer single pin cost-block reason for all non-verifiable cost outcomes

### A-030 — CLAIMED lease skips cost reprobe

Valid same-owner CLAIMED lease: reuse attributed `binding_id`; NO availability / quota / cost reprobe; NO constraint reevaluation.

Pre-claim cost filtering ≠ automatic failover. Automatic failover remains deferred.

---

## Decision

Live routing activates `ACTIVE_COST_ROUTING=YES` / `COST_ROUTING_POLICY=LIVE` using S10 policy composition on the S9 path.

Routing-block evidence may include sanitized `cost_observations: [{ binding_id, state, estimate? }]` and evaluation-snapshot `cost_constraint: { max_estimate: { amount_decimal, currency_code } }` only (no raw probe detail; snapshot is not spend authority). Schema v6 unchanged.

### Non-goals for S11

- Automatic failover / alternate-binding retry after attribution
- Automatic escalation
- Cheapest ranking / currency conversion / price tables
- Actual cost accounting / spend authorization
- SQLite schema change / durable cost store

---

## Consequences

Later slices may add escalation and failover under fencing when Program Control authorizes. Human cost authority predicates remain required for material ceiling / charging changes.
