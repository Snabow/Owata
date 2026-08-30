# DEC-004-004 — Durable Binding Attribution (WP-004-S4)

**ID:** DEC-004-004
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S4
**Authority:** Program Control (OWATA-REQ-0085)
**Related:** `decisions/DEC-004-003-selection-boundary.md` (A-007 / A-008)

Builder MUST NOT expand or change this Decision beyond recording the Program Control boundary below.

---

## Context

S3 can select a Router `binding_id`, but dispatches previously recorded no durable Router identity. Gateway `adapter_id` is a distinct identity (A-008). Failover and later cutover require per-attempt durable attribution without guessing from adapters.

---

## Decision

### Schema v6

`SCHEMA_VERSION = 6`

Additive column only:

```text
dispatches.binding_id TEXT NULL
```

- **NULL** — no Router attribution supplied (pre-cutover / unspecified path)
- **Non-NULL** — exact Router registry `binding_id` for that dispatch attempt

No historical guessing or backfill from `adapter_id`.

### Per-attempt identity

`binding_id` is per dispatch attempt. Different attempts for the same request MAY record different `binding_id` values (future failover). Lifecycle operations (accept / reject / renew / expire / recover) MUST preserve the attributed value unchanged.

### Claim API

`claimDispatch` accepts optional `bindingId?: string | null`.

- Provided non-empty string → persist exact value
- Absent / null → persist NULL
- Empty string → fail closed before durable claim

### Event evidence

New `cycle.dispatch_claimed` payloads include `binding_id` (possibly null). Historical events are not rewritten.

### Non-goals for S4

- No active Router cutover into Dispatcher / Gateway / canary
- No FailureClass mapping
- No quota / cost / escalation / failover
- No Router persistence inside selection
- Gateway `adapter_id` remains distinct from registry `binding_id`

Durable binding identity is a prerequisite for later failover acceptance.

---

## Consequences

Later active routing cutover may supply `bindingId` at claim time from S3 `selectBinding`. Failover may attribute a different `binding_id` on a subsequent attempt under fencing.
