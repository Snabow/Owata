# OWATA-REQ-0055 — Durable development-control continuity

**REQUEST_ID:** OWATA-REQ-0055
**STATUS:** ACCEPTED / CLOSED via OWATA-REQ-0060 (B2-S2 acceptance + B2 graduation)
**PARENT tip:** `b70d2c1da8f8a66d1d84c5d9c38cd65a22c9d779`
**BRANCH:** `wp-003/b2-s2-real-program-control`

## Objective

REAL_PROGRAM_CONTROL + FULL_NO_RELAY_CYCLE (WP-003 B2-S2).

## Decision

`DEC-003-004-real-program-control-full-no-relay.md` (ACCEPTED by Program Control OWATA-REQ-0055).

## Acceptance / graduation (Program Control OWATA-REQ-0060)

| Field | Value |
| --- | --- |
| B2_S2 | ACCEPTED |
| B2_S2_ACCEPTED | YES |
| B2 | GRADUATED |
| B2_GRADUATED | YES |
| Final Independent Review | OWATA-REQ-0059 PASS / READY |
| Final reviewed target | `65556667184998a8a8228a31a5db604a20192279` |
| Runtime source | `2fce4ace33d60e5e97f0a7b197c3c852a769e440` |
| Post-canary test-only | `83c981dee29a5d9544bc6832435fd1544817ccfe` |
| Canonical run | `evidence/artifacts/wp-003-b2-s2/run_2026-08-30T02-32-43-627Z` |
| WP003_DONE | NO (OPEN / CLOSURE REMAINS; next: WP003_CLOSURE_AUDIT) |

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

Canonical successful candidates:

- A: `2b55aeea55c959131819d6d040cb782bd04dbfaa`
- B (accepted): `c800068cb144c2c8eb824a9a6e405e7526702247`
- Finding: `REV-003-B2-S2-001` (scope correlation PASS)

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
- Current non-Claude Builder restriction is local execution/canary policy (not universal “never Claude”).
- `CATEGORY` labels in Program Control adjudication are metadata only (not a product schema).
- Browser Relay is development transport only; prohibited in the product canary.

## Known non-blocking debt

OWATA-REQ-0059-NB-001 (REPOSITORY_HYGIENE / LOW) — deferred; historical `git diff --check` CRLF noise. Does not block B2 acceptance.

## Historical diagnostic runs (not canonical PASS)

- `evidence/artifacts/wp-003-b2-s2/run_2026-08-30T01-44-57-755Z`
- `evidence/artifacts/wp-003-b2-s2/run_2026-08-30T02-13-47-129Z`

A fresh agent reconstructs from this record + Git + DEC-003-004 + `evidence/wp-003-b2-s2.md`, not from chat.
