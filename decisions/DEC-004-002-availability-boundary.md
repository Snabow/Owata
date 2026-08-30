# DEC-004-002 — Availability Boundary (WP-004-S2)

**ID:** DEC-004-002
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S2
**Authority:** Program Control (OWATA-REQ-0075)
**Related:** `decisions/DEC-004-001-router-s1-boundary.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control boundary below.

---

## Context

WP-004-S1 delivered static eligibility (enabled / role / capability / deterministic order). Phase 4 next dependency is availability semantics before quota, cost, failover, or dispatch cutover.

---

## Decision

### Per-binding availability

Availability is observed **per binding_id**, not per provider/model as architecture.

Exact states:

| State | Meaning |
| --- | --- |
| `AVAILABLE` | `probe.ok=true` AND `probe.authReady=true` |
| `CREDENTIAL_UNAVAILABLE` | `probe.ok=true` AND `probe.authReady=false` |
| `AGENT_UNAVAILABLE` | `probe.ok=false` (dominates authReady) |
| `UNKNOWN` | no current observation for an eligible binding |

`UNKNOWN` is fail-closed: never treated as `AVAILABLE`.

### Overlay

S1 eligibility remains authoritative for static filter and order (`priority ASC`, then `binding_id ASC`).

S2 overlays observations onto the S1 eligible set and returns exactly one of:

- `AVAILABLE` — non-empty bindings still in S1 order
- `NO_ELIGIBLE_BINDING` — S1 had none
- `NO_AVAILABLE_BINDING` — S1 had eligible bindings but none `AVAILABLE`

`NO_ELIGIBLE_BINDING` and `NO_AVAILABLE_BINDING` remain distinct. Neither is mapped to Control Core `FailureClass` in S2.

### Non-goals for S2

- No dispatch selection / failover / retry
- No quota / cost / model-policy embedding
- No SQLite schema; observations are **ephemeral**
- No TTL/stale-cache layer
- No provider-specific branching
- No active Dispatcher/Gateway cutover

---

## Consequences

Later integration may inspect observation states to distinguish credential vs agent unavailability when mapping to recovery actions. S2 itself does not choose those actions.
