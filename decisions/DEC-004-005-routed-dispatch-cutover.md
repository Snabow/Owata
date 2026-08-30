# DEC-004-005 — Routed Dispatcher Cutover (WP-004-S5)

**ID:** DEC-004-005
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-004-S5
**Authority:** Program Control (OWATA-REQ-0089)
**Related:** `decisions/DEC-004-003-selection-boundary.md`, `decisions/DEC-004-004-durable-binding-attribution.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control boundary below.

---

## Context

S1–S4 delivered registry eligibility, availability overlay, deterministic selection, and durable `binding_id` attribution without active runtime cutover. S5 activates the Router pipeline at the Dispatcher execution boundary.

---

## Decision

### S5 active Router cutover boundary

When Dispatcher `options.routing` is configured:

```text
ProviderRegistry
→ S1 eligibility
→ current availability observations (catalog probe or UNKNOWN)
→ S3 selectBinding (initial) OR same-request pin
→ exact runtime catalog adapter
→ claimDispatch({ bindingId })
→ invoke
```

When `options.routing` is absent, legacy fixed `DispatcherAdapters` behavior is unchanged.

### Explicit runtime catalog

Runtime catalog entries are keyed by explicit registry `binding_id` and bind:

- role
- role-correct RoleAdapter
- provider-neutral `{ ok, authReady, detail? }` probe

`binding_id` is never derived from `adapter_id`, `provider_id`, `runtime_id`, or `model_id`.

Gateway `adapter_id` remains a distinct identity (A-008 preserved).

### Catalog validation (fail closed)

- empty / duplicate catalog `binding_id`
- catalog role ≠ adapter.identity.role
- catalog `binding_id` absent from registry
- registry role ≠ catalog role

Missing registry bindings without a catalog entry are allowed and observe as `UNKNOWN` (fail-closed for selection).

Extra catalog entries that fail validation throw `ROUTING_CONFIG_INVALID`.

### No legacy fallback

When routing is configured, routed-path failures MUST NOT silently fall back to the fixed adapter triple.

### Initial selection

Initial attempt selection remains accepted S3: first AVAILABLE binding in exact S1 order.

### Same-request pinning (no automatic failover)

If the same `request_id` already has a prior dispatch with non-null `binding_id`, subsequent automatic attempts are **pinned** to that binding.

Pin checks: registry presence, role/capability eligibility, catalog presence, current AVAILABLE.

On pin failure → routing recovery; do **not** select another binding.

### NULL provenance fail-closed

Prior same-request dispatch with `binding_id = NULL` while routed mode is active → `ROUTING_PROVENANCE_MISSING` recovery. Do not convert unattributed lineage into a newly selected binding.

### Semantic RETRY / new request_id

Program Control semantic RETRY creates a new `request_id` and MAY perform fresh Router selection. That is PC-authorized recovery, not automatic same-request failover.

### Routing block evidence (A-009)

Pre-dispatch Router blocks:

- emit durable `cycle.routing_blocked` (observations as `{ binding_id, state }` only; no raw probe detail)
- enter `RECOVERY_REQUIRED` via existing lineage rules
- create **no** DispatchRecord / FailureClass fabrication

A-009: a pre-dispatch Router block is **not** a dispatch FailureClass because no dispatch exists yet.

Router-native reasons include: `NO_ELIGIBLE_BINDING`, `NO_AVAILABLE_BINDING`, `ROUTING_PROVENANCE_MISSING`, `ROUTING_CONFIG_INVALID`, pin-failure codes.

Post-claim Gateway/runtime failures continue using existing FailureClass semantics.

### Non-goals for S5

- Automatic failover / alternate-binding retry
- Quota observation
- Cost accounting
- Automatic escalation
- FailureClass mapping of Router outcomes onto fabricated dispatches
- Schema change (remains v6)
- Provider registry / model-policy changes

### Program Control semantic authority

Router decides only which eligible/available binding executes a requested logical role. PC retains BUILD / REWORK / ACCEPT / RETRY / REDESIGN / HUMAN_GATE / ABORT / review sufficiency / WP completion.

---

## Consequences

Active runtime cutover is live on the configured Dispatcher path (including the full no-relay canary wire). Failover and quota/cost/escalation remain deferred.
