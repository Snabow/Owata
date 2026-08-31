# DEC-004-014 — Failover Under Fencing (WP-004-S13)

**ID:** DEC-004-014
**Status:** CANDIDATE (implementation complete; pending Independent Review + Program Control acceptance)
**Date:** 2026-08-31
**Work Package:** WP-004-S13
**Authority:** Program Control (OWATA-REQ-0145)
**Related:** `decisions/DEC-004-013-automatic-escalation.md`, `decisions/DEC-004-012-live-cost-routing-cutover.md`, `decisions/DEC-004-005-routed-dispatch-cutover.md`, `decisions/DEC-004-006-human-routine-approval-zero.md`

Builder MUST NOT expand or change this Decision beyond recording the Program Control adjudications below.

---

## Context

S12 delivered pre-attribution automatic escalation evidence while preserving pin / CLAIMED-lease no-alternate behavior and `AUTOMATIC_FAILOVER=NO`. S13 adds the final Phase-4 Router capability: **explicitly opted-in automatic failover under durable fencing** after a prior attempt is durably terminal. Default remains no failover. S12 escalation MUST NOT be conflated with S13 post-terminal failover.

---

## Program Control adjudications

### A-035 — Explicit fenced opt-in

```ts
type FailoverPolicy = { mode: "FENCED" };
// RoutingConfig.failoverPolicy?: FailoverPolicy
```

- Missing / absent → **DISABLED** (preserve today's pin / no-alternate behavior)
- `{ mode: "FENCED" }` → enabled
- Malformed → `ROUTING_CONFIG_INVALID`
- Failover opt-in is **NOT** spend approval
- Same `costConstraint`; no ceiling change; no currency change; no invented cost authority

Canonical defaults:

- `AUTOMATIC_FAILOVER_DEFAULT=NO`
- `AUTOMATIC_FAILOVER_POLICY=EXPLICIT_FENCED_OPT_IN`
- Candidate may record `FAILOVER_UNDER_FENCING=YES_WHEN_EXPLICITLY_ENABLED`
- Do **not** canonicalize `AUTOMATIC_FAILOVER=YES` as an accepted capability before Independent Review and Program Control acceptance

### A-036 — Failover-eligible prior attempt

Automatic failover may proceed only when the **latest** dispatch for the **same** `request_id` is durably terminal and is one of:

- `EXPIRED`
- `REJECTED` + `AGENT_UNAVAILABLE`
- `REJECTED` + `CREDENTIAL_UNAVAILABLE`
- `REJECTED` + `RUNTIME_ERROR`

MUST NOT automatically fail over for:

- `CAPABILITY_BLOCK`
- `REPO_UNAVAILABLE`
- `RESULT_INVALID`
- `RESULT_STALE`
- `PRODUCT_FAILURE`
- `ACCEPTED`
- live `CLAIMED`
- any preclaim routing block
- any other / unknown / ambiguous state → **fail closed** (pin or existing recovery as today)

Live same-owner `CLAIMED` lease remains exact reuse (A-030); **NO** failover.

### A-037 — Fencing / attempt identity

Before an alternate binding may be claimed, the prior attempt's fence MUST be dead (terminal states above establish that).

A failover attempt for one logical request MUST preserve:

- same `request_id`

and MUST create:

- new `dispatch_id`
- new `fence_token`
- `attempt_number = prior attempt_number + 1`
- different `binding_id`

A late result from an older / dead fence MUST NOT become accepted after the new failover attempt exists. Reuse existing `ControlStore` / `HandoffStore` claim authority; do not create a second claim authority.

### A-038 — Alternate selection

For failover, exclude **every** `binding_id` already attempted for that same `request_id`.

From the remaining untried bindings, apply current accepted routing semantics and deterministic order:

eligibility → availability → quota → cost

Select the first current-routable untried binding.

Required behavior:

- A → B → C allowed
- A → B → A → B **prohibited** as automatic failover (exclusion set prevents ping-pong)

If no untried current-routable binding exists, fail closed into the existing recovery path. Do not fabricate a candidate.

Do not alter existing pre-attribution S12 winner semantics. Do not classify failover as S12 escalation. Do not emit `cycle.routing_selected` for failover attempts.

### A-039 — Durable evidence / atomicity

Add durable evidence event: `cycle.failover_selected`.

On a **NEW** failover claim, couple via `claimDispatch({ coupledEvent })` the same way S12 couples `cycle.routing_selected` — **SAME** `runImmediate` success transaction as:

- new `CLAIMED` dispatch
- new binding attribution
- new fence / attempt identity
- `cycle.dispatch_claimed`
- `cycle.failover_selected`

An injected failure before COMMIT must leave **none** of the new failover claim / evidence durable.

`RETRY_BUDGET` / `enterRecovery` remain outside the success transaction so recovery stays durable.

Schema remains v6 preferred (event-type union only; no SQLite schema change).

---

## Decision

`FAILOVER_UNDER_FENCING=YES_WHEN_EXPLICITLY_ENABLED` with policy `EXPLICIT_FENCED_OPT_IN`. Automatic failover is post-terminal, fenced, same-request alternate selection under the existing eligibility → availability → quota → cost stack. It does not authorize spend, ceiling changes, S12-style escalation reclassification, or ping-pong reuse of attempted bindings.

### Non-goals for S13

- Default-on automatic failover (`AUTOMATIC_FAILOVER_DEFAULT` remains NO)
- Canonicalizing `AUTOMATIC_FAILOVER=YES` before IR + Program Control acceptance
- Registry / canary / model-policy changes
- Real model invocations / Phase 5
- Self-acceptance (`S13_ACCEPTED=NO`, `WP004_DONE=NO` until Program Control)

---

## Consequences

After Program Control acceptance of S13, Phase 4 Router charter bullets for failover under fencing close. Remaining Phase 4 optional: actual cost accounting unless later acceptance requires it. Independent Review remains mandatory before acceptance.
