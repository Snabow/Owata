# DEC-004-010 — Live Quota Routing Cutover (WP-004-S9)

**ID:** DEC-004-010
**Status:** ACCEPTED
**Date:** 2026-08-31
**Work Package:** WP-004-S9
**Authority:** Program Control (OWATA-REQ-0118)
**Related:** `decisions/DEC-004-005-routed-dispatch-cutover.md`, `decisions/DEC-004-009-quota-routing-policy.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S8 defined pure `selectBindingWithQuota` without live Dispatcher wiring. S9 activates that policy on the existing S5 routed path for **initial** binding selection while preserving same-request pinning and fencing.

---

## Program Control adjudications

### A-019 — Optional live quota probe

`RuntimeCatalogEntry` may include optional `quotaProbe?: () => QuotaProbeResult | Promise<QuotaProbeResult>`.

- Missing `quotaProbe` → quota state `UNKNOWN` (backward-compatible; preserves S5 order via S8 UNKNOWN fallback)
- Probe exception → `UNKNOWN`
- Non-boolean `exhausted` → `UNKNOWN`
- No probe retry; no provider-specific branching

### A-020 — Live initial quota selection

For a request with no prior attributed dispatch:

```text
ProviderRegistry → eligibility → availability observations
→ quota observations for availability-AVAILABLE only
→ selectBindingWithQuota (S8 policy)
→ catalog adapter → claimDispatch(binding_id) → invoke
```

Policy: AVAILABLE preferred; UNKNOWN fallback (remains UNKNOWN); EXHAUSTED excluded.
All availability-AVAILABLE candidates EXHAUSTED → Router block `NO_QUOTA_ROUTABLE_BINDING` (pre-claim; not failover).

### A-021 — Same-request pinning with quota

Prior non-null `binding_id` for the same `request_id`:

- Exact pin only; no multi-binding reselection
- Availability then quota on pinned binding only
- AVAILABLE / UNKNOWN → remain pinned
- EXHAUSTED → `PINNED_BINDING_QUOTA_EXHAUSTED` (never alternate binding)
- Valid same-owner CLAIMED lease: reuse attributed binding; do not re-probe/reselect

Pre-claim EXHAUSTED candidate filtering ≠ automatic failover. Automatic failover remains deferred.

---

## Decision

Live routing activates `ACTIVE_QUOTA_ROUTING=YES` / `QUOTA_ROUTING_POLICY=LIVE` using S8 policy composition.

Routing-block evidence may include sanitized `quota_observations: [{ binding_id, state }]` only (no raw detail). Schema v6 unchanged.

### Non-goals for S9

- Automatic failover / alternate-binding retry after attribution
- Automatic escalation
- Cost-aware routing / spend authorization
- SQLite schema change / durable quota store

---

## Consequences

Later slices may add cost routing policy, escalation, and failover under fencing when Program Control authorizes.
