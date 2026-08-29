# WP-003 Slice 2 — Real Builder Binding + B1 Canary (evidence)

**Request:** OWATA-REQ-0039  
**Branch:** `wp-003/slice-2-real-builder`  
**Authoritative base:** `f3f77b0c1d6a11f1fcd0aac3adffd3fa3a6809ff`  
**Decision:** `decisions/DEC-003-003-real-builder-binding-b1-canary.md`  
**Architecture challenge input:** OWATA-REQ-0038 (Fable) — advisory only; PC adjudicated ACCEPT_WITH_CHANGES

## Implementation status

| Gate | Status |
|------|--------|
| Gateway stateless (library behind adapters) | PASS (code) |
| Async adapter + lease heartbeat | PASS (code + unit tests) |
| Worktree per attempt | PASS (unit tests) |
| Prompt compiler + hash | PASS (unit tests) |
| Git reality verification | PASS (unit tests) |
| Cursor CLI probe | PASS (CLI installed `2026.08.25-3e8eec8`) |
| Cursor CLI auth | **HUMAN_REQUIRED** (`agent status`: Not logged in; no `CURSOR_API_KEY`) |
| Explicit non-Claude model | BLOCKED pending auth (`agent --list-models` requires auth) |
| Real Builder canary | **BLOCKED** — `CREDENTIAL_UNAVAILABLE` |
| CLAUDE_USED | NO |
| AUTO_ROUTER_USED | NO |
| Real ProgramControlAdapter | NONE |
| Real ReviewerAdapter | NONE |
| Model Router | NONE |
| B1_CANARY_CANDIDATE | NOT_READY |
| WP-003 DONE | NO |
| B1 GRADUATION | NOT YET |

## Normal suite

```text
npm test → 105 pass / 0 fail
npm run build → PASS
```

## Real canary

```text
npm run canary
→ {"status":"BLOCKED","reason":"CREDENTIAL_UNAVAILABLE"}
exit 2
```

## Human action required

Provide Cursor Agent CLI authentication without pasting secrets into chat:

1. Run `agent login` on this machine (or set `CURSOR_API_KEY` in the environment out-of-band), then
2. Re-authorize Builder to re-run `npm run canary` and complete RESULT for OWATA-REQ-0039.

Do not use Claude-family models or Cursor Auto for the canary.

## SHAs

- IMPLEMENTATION_SHA: `9582212d3e840b8cbd4cb5ce778b5d9a651c3588`
- DECISION_SHA: `9582212d3e840b8cbd4cb5ce778b5d9a651c3588` (DEC-003-003 included)
- HEAD: `9582212d3e840b8cbd4cb5ce778b5d9a651c3588` (may advance with evidence-only follow-up)
