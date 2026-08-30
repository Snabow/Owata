# OWATA-REQ-0055 — Durable development-control continuity

**REQUEST_ID:** OWATA-REQ-0055  
**STATUS:** PARTIAL / REWORK_IN_PROGRESS  
**PARENT tip:** `b70d2c1da8f8a66d1d84c5d9c38cd65a22c9d779`  
**BRANCH:** `wp-003/b2-s2-real-program-control`  

## Objective

REAL_PROGRAM_CONTROL + FULL_NO_RELAY_CYCLE (WP-003 B2-S2).

## Decision

`DEC-003-004-real-program-control-full-no-relay.md` (ACCEPTED by Program Control OWATA-REQ-0055).

## Canary required lineage (synthetic B2-S2 canary scope)

```text
BUILD (+ install_policy DISPATCH_REVIEW)
→ Reviewer REWORK
→ PC authorized REWORK
→ Builder (descendant of reviewed candidate)
→ Reviewer PASS
→ PC ACCEPT
```

Exact accepted semantic counts for a successful canary:

- PC accepted decisions = 3 (`BUILD`, `REWORK`, `ACCEPT`)
- Builder accepted results = 2
- Reviewer accepted results = 2 (`REWORK`, `PASS`)

**Exact 3/2/2 is synthetic B2-S2 canary scope, not universal OWATA semantics.**

## External invocation maximum (canary-local)

- PC ≤ 3
- Builder ≤ 2
- Reviewer ≤ 2
- Total ≤ 7

No automatic second full canary run after a failed/rejected external invocation.

## Absolute invariants

- `human_continuity_actions=0`
- `browser_relay_product_invocations=0`
- `manual_role_invocations=0`
- `manual_role_routing=0`
- `manual_session_continuity=0`
- `stale_result_canonicalization=0`
- `reviewer_source_mutation=0`
- `dispatcher_finding_adjudication=0`
- `auto_rework_before_pc=NO`

## Policy notes

- Provider/model architecture remains agnostic.
- Current non-Claude Builder restriction is local execution/canary policy.
- `CATEGORY` labels in Program Control adjudication are metadata only (not a product schema).
- Browser Relay is development transport only; prohibited in the product canary.

## Historical diagnostic runs (not canonical PASS)

- `evidence/artifacts/wp-003-b2-s2/run_2026-08-30T01-44-57-755Z`
- `evidence/artifacts/wp-003-b2-s2/run_2026-08-30T02-13-47-129Z`

A fresh agent reconstructs from this record + Git + DEC-003-004 + `evidence/wp-003-b2-s2.md`, not from chat.
