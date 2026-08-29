# WP-003 Slice 2 窶・Real Builder Binding + B1 Canary (evidence)

**Request lineage:** OWATA-REQ-0039 (BLOCKED / policy qualification) 竊・OWATA-REQ-0040 (RESUME)  
**Branch:** `wp-003/slice-2-real-builder`  
**Authoritative base:** `f3f77b0c1d6a11f1fcd0aac3adffd3fa3a6809ff`  
**Decision:** `decisions/DEC-003-003-real-builder-binding-b1-canary.md`

## Provider policy qualification (REQ-0039)

- CLAUDE_SUCCESSFUL_EXECUTION: NO
- CLAUDE_EXPLICIT_INVOCATION_ATTEMPT: YES (one Fable Task spawn request failed on usage-limit; produced no implementation work)
- PROVIDER_POLICY_VIOLATION: YES
- Do not retain a bare `CLAUDE_USED: NO` without the above qualification for REQ-0039.

## REQ-0040 outer binding

- OUTER_CAUTO_AUTHORIZED_BY_HUMAN: YES
- EXPLICIT_CLAUDE_TASK_INVOKED: NO

## Implementation status

| Gate | Status |
|------|--------|
| Gateway stateless | PASS |
| Async adapter + lease heartbeat | PASS |
| Worktree per attempt | PASS |
| Prompt compiler + hash | PASS |
| Git reality verification | PASS |
| Cursor CLI | `2026.08.25-3e8eec8` / auth READY |
| INNER_MODEL_USED | `composer-2.5` (explicit; Sol listed but spend-limited) |
| INNER_MODEL_EXPLICIT | YES |
| INNER_AUTO_USED | NO |
| Real Builder canary | **PASS** |
| B1_CANARY_CANDIDATE | **PASS** |
| B1 GRADUATION | NOT YET (PC + Independent Review only) |
| WP-003 DONE | NO |

## Real canary evidence (REQ-0040)

```text
status: B1_CANARY_CANDIDATE
request_id: req_15 (same across attempts)
attempt1_dispatch_id: dsp_19 窶・killed pid 23648 窶・state EXPIRED
attempt2_dispatch_id: dsp_23 窶・attempt_number 2 窶・fence differs
stale_attempt_rejected: true
candidate_sha: 97b59066e57b9600c2f48f32c9dc4a67913c438f
readme: STATUS=READY
model_id: composer-2.5
prompt_hash_attempt1: c2fdc86d76f53baf8cd4e7bce50bb75c856f184de40d95eaf30254f92230bd2b
human_continuity_actions: 0
resume/continue: not used
```

Canary fixes included in follow-up commits (still Slice 2 candidate; not B1 graduation):

- create disposable repo directory before `git init`
- seed `CANARY_TASK.md` + compiler obligation to execute it
- prefer `composer-2.5` when Sol is catalog-preferred but spend-limited

## Normal suite

```text
npm test 竊・105 pass / 0 fail
npm run build 竊・PASS
```

## SHAs

- IMPLEMENTATION_SHA: `9582212d3e840b8cbd4cb5ce778b5d9a651c3588`
- Pre-canary tip: `61204a1bb981c6c9fb32ed34614ba4a037245746`
- HEAD after canary evidence / canary hardening: 
- HEAD: `32595fec2e65b53ba359b99773c0e7e7e0ccea72`

