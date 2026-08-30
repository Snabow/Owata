# DEC-004-009 — Quota Routing Policy + Pure Composition (WP-004-S8)

**ID:** DEC-004-009
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S8
**Authority:** Program Control (OWATA-REQ-0113)
**Related:** `decisions/DEC-004-007-quota-observation-boundary.md`, `decisions/DEC-004-003-selection-boundary.md`, `decisions/DEC-004-005-routed-dispatch-cutover.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S6 delivered quota observation without deciding UNKNOWN routability. A stale `quota.ts` JSDoc claimed UNKNOWN was fail-closed for quota-aware consumers, contradicting DEC-004-007. S8 hardens the observation contract and defines the first explicit quota routing policy as a pure composition API without live Dispatcher wiring.

---

## Program Control adjudications

### A-016 — Quota observation runtime contract hardening

Preserve exact states: `AVAILABLE` | `EXHAUSTED` | `UNKNOWN`.

Raw probe:

- `null` / `undefined` → `UNKNOWN`
- `exhausted === false` → `AVAILABLE`
- `exhausted === true` → `EXHAUSTED`
- non-boolean `exhausted` → `UNKNOWN` (no truthy/falsy coerce)

Relevant normalized observations:

- state must be exactly `AVAILABLE` / `EXHAUSTED` / `UNKNOWN` else `QUOTA_INVALID`
- duplicate relevant `binding_id` → `QUOTA_INVALID`
- unrelated observations ignored **before** validation (cannot inject; malformed/duplicate unrelated do not fail assessment)

This aligns implementation with DEC-004-007 A-011. S8 supersedes only the stale JSDoc wording, not DEC-004-007 semantics.

### A-017 — Quota routing policy

After S1 eligibility and S2 availability filtering:

| Quota state | Routability |
| --- | --- |
| `AVAILABLE` | ROUTABLE and preferred |
| `UNKNOWN` | ROUTABLE as fallback only (remains `UNKNOWN`) |
| `EXHAUSTED` | NOT ROUTABLE |

`UNKNOWN` is **not** reclassified as `AVAILABLE`. Priority: all `AVAILABLE` (S1/S2 order), then all `UNKNOWN` (S1/S2 order). If only `EXHAUSTED` remain among availability-eligible candidates → `NO_QUOTA_ROUTABLE_BINDING`.

### A-018 — Pure composition API only

`selectBindingWithQuota(registry, request, availabilityObservations, quotaObservations)`:

```text
ProviderRegistry
→ S1 filterEligibleBindings
→ S2 overlayAvailability
→ S6 assessQuota over AVAILABLE candidates
→ S8 quota policy
→ QuotaAwareBindingSelectionResult
```

SELECTED results expose `quota_state: AVAILABLE | UNKNOWN` so UNKNOWN fallback cannot be mistaken for quota AVAILABLE.

Upstream outcomes preserved: `NO_ELIGIBLE_BINDING` / `NO_AVAILABLE_BINDING`.

No live Dispatcher cutover, FailureClass mapping, failover, escalation, or persistence. `selectBinding()` behavior unchanged. Cost APIs unused.

---

## Decision

Pipeline addition (offline / pure):

```text
registry + request + availabilityObs + quotaObs
→ selectBindingWithQuota()
→ SELECTED{binding,quota_state} | NO_ELIGIBLE_BINDING | NO_AVAILABLE_BINDING | NO_QUOTA_ROUTABLE_BINDING
```

### Non-goals for S8

- No `ACTIVE_QUOTA_ROUTING` live cutover
- No automatic failover / escalation
- No cost-aware routing / actual cost accounting
- No provider-specific quota / remaining_tokens / rate windows
- No SQLite / SCHEMA_VERSION change

---

## Consequences

Later slices may wire this pure policy into live Dispatcher when Program Control authorizes cutover. S8 itself does not change live selection.
