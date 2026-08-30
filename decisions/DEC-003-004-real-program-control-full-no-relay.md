# DEC-003-004 — Real Program Control Adapter + Full No-Relay Canary

**ID:** DEC-003-004
**Status:** ACCEPTED
**Date:** 2026-08-30
**Work Package:** WP-003
**Authority:** Program Control — OWATA-REQ-0055
**Related:** `DEC-003-001`, `DEC-003-002`, `DEC-003-003`

Convention: architecture decisions live in `decisions/DEC-<wp>-<seq>-<slug>.md`. Status is `PROPOSED` | `ACCEPTED` | `SUPERSEDED`. Chat history is not a Decision.

---

## Context

B1 graduated real Builder. B2-S1 accepted real Independent Reviewer. Human Clipboard Zero for a complete cycle still requires a real `ProgramControlAdapter` and one full Program Control → Builder → Reviewer → Program Control path without Browser Relay as product runtime.

---

## Decision

### D1 — Provider-neutral Program Control adapter

**ACCEPT.**

`ProgramControlAdapter` remains provider-neutral. Control Core must not encode Codex, Cursor, ChatGPT, or Claude as workflow semantics. Binding/runtime details stay behind a replaceable Program Control binding (`probe` / `start` / `wait` / `cancel`).

### D2 — Binding separation

**ACCEPT — MANDATORY.**

Program Control binding/session MUST be separate from Independent Reviewer binding/session. Temporary B2-S2 Program Control Champion MAY be isolated `codex-cli` under a distinct binding id/session. Cursor Builder MUST NOT be Program Control. Claude-family runtimes MUST NOT be Program Control for this canary.

### D3 — Program Control output contract

**ACCEPT.**

Real Program Control returns only canonical `program_control_decision` envelopes (`from_role=program_control`, `to_role=dispatcher`). It does not implement, review as Reviewer, merge, or suppress findings.

### D4 — Deterministic authority gates

**ACCEPT — MANDATORY.**

Before applying ACCEPT / REWORK:

- **ACCEPT** only if the latest Reviewer result for the exact latest candidate is PASS, there is no newer candidate than that reviewed SHA, and there is no unresolved REWORK/BLOCK ahead of that PASS.
- **REWORK** only if the latest Reviewer result for the exact latest candidate is REWORK and `authorized_finding_ids` is a non-empty subset of that result's findings.
- Invented or stale finding IDs are rejected fail-closed.

### D5 — Full no-relay canary

**ACCEPT.**

Product canary for B2-S2 MUST run without Browser Relay / Human Clipboard as runtime transport. One command drives real Program Control + real Builder + real Reviewer through a complete cycle. Full canary requires a Reviewer REWORK path before PASS, then Program Control ACCEPT.

### D6 — Non-goals

**ACCEPT.**

Do not add Model Router, Capability Catalog, or UI in B2-S2. Do not claim B2 graduated or WP-003 DONE from this Decision alone. Browser Relay may remain a development transport outside the product canary path.

---

## Consequences

- Implement `src/program-control/` Gateway + Codex PC Champion binding + authority guards.
- Wire Dispatcher to pass request/dispatch/signal into Program Control and enforce ACCEPT/REWORK authority.
- Ship opt-in `npm run canary:b2-full` with durable evidence under `evidence/artifacts/wp-003-b2-s2/`.
- B2 remains IN_PROGRESS until Program Control accepts the canary and Independent Review closes the slice.
