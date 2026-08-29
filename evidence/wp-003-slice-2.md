# WP-003 Slice 2 — Real Builder Binding + B1 Canary (evidence)

**Request lineage:** OWATA-REQ-0039 → OWATA-REQ-0040 → OWATA-REQ-0041 (REWORK) → OWATA-REQ-0042 (REWORK)
**Branch:** `wp-003/slice-2-real-builder`
**Authoritative base:** `f3f77b0c1d6a11f1fcd0aac3adffd3fa3a6809ff`
**Decision:** `decisions/DEC-003-003-real-builder-binding-b1-canary.md`

## Provider policy qualification (REQ-0039)

- CLAUDE_SUCCESSFUL_EXECUTION: NO
- CLAUDE_EXPLICIT_INVOCATION_ATTEMPT: YES (one Fable Task spawn request failed on usage-limit; produced no implementation work)
- PROVIDER_POLICY_VIOLATION: YES
- Do not retain a bare `CLAUDE_USED: NO` without the above qualification for REQ-0039.

## Outer / inner binding

- OUTER_CAUTO_AUTHORIZED_BY_HUMAN: YES (REQ-0040 / REQ-0042)
- EXPLICIT_CLAUDE_TASK_INVOKED: NO
- INNER_MODEL_USED: `composer-2.5` (explicit)
- INNER_AUTO_USED: NO

## REQ-0042 F01–F06 resolution

| Finding | Status |
|---------|--------|
| F01 git reality fail-closed for non-fake Builder | PASS |
| F02 complete authority prompt compiler + resolved findings | PASS |
| F03 durable canary evidence bundle retained in Git | PASS |
| F04 atomic lease renewal + typed heartbeat RESULT_STALE | PASS |
| F05 authReady in Gateway preflight | PASS |
| F06 trailing whitespace (`git diff --check`) | PASS |

## Implementation status

| Gate | Status |
|------|--------|
| Gateway stateless | PASS |
| Async adapter + lease heartbeat | PASS |
| Worktree per attempt | PASS |
| Prompt compiler + hash (complete authority) | PASS |
| Git reality verification (mandatory non-fake) | PASS |
| Cursor CLI | `2026.08.25-3e8eec8` / auth READY |
| Real Builder canary (REQ-0042) | **PASS** |
| B1_CANARY_CANDIDATE | **PASS** (candidate; not graduated) |
| B1 GRADUATION | NOT YET (PC + Independent Review only) |
| WP-003 DONE | NO |

## Durable canary evidence (REQ-0042)

Retained under:

`evidence/artifacts/wp-003-slice-2/run_2026-08-29T16-28-01-680Z/`

```text
status: B1_CANARY_CANDIDATE
owata_source_sha: a10ba5398a96ca779850c61e002e28a236ba17be
request_id: req_15 (same across attempts)
attempt1: dsp_19 / fence_20 / pid 24916 killed / EXPIRED
attempt2: dsp_23 / fence_24 / ACCEPTED / fence differs
stale_attempt_rejected: true
candidate_sha: c540306fa48da5df55f8ee920cf84c5612bbf335
candidate_resolution_check: PASS (task-repo.bundle)
readme: STATUS=READY
model_id: composer-2.5
human_continuity_actions: 0
resume/continue: not used
manifest_content_sha256: 79ce78e77d4a4aa6dd43c2abb2907627e203656c53b4855b251edac0bffcb866
```

Artifact hashes (from manifest):

- durable-state.json: `6d6a76b257c597f7e88a632432b37cec8f7b7a0adab4cc7b40a24e2aee162c0a`
- attempt1-instruction.txt: `577fd47ea74f681629fd146640f3a712ba5105b779dd509410adea9381ba54bb`
- attempt2-instruction.txt: `eafa29b1961fd5b54b05992d4ea52808275b9c552a8510953c58a3aaf3ddfb35`
- attempt2-result-envelope.json: `41818124ba4077f1b3216ddbe8b112ad81da2f33ca3e70ee4f29abfcaf31df72`
- task-repo.bundle: `234ad515ef7b778e59bb824cf495c46ecf740d0bc69fb7cd53adc6e03dc01690`
- invocation-flags.json: `49cb8af5cfd646f22e1b4a37c63c5b2c4f92226621a90296d7df804c0b3cffca`

No raw runtime-output / credentials retained.

## Normal suite (pre-canary)

```text
npm ci --ignore-scripts → PASS
npm ls --all → PASS
npm test → 119 pass / 0 fail
npm run build → PASS
git diff --check (working tree / post-fix tip) → PASS
```

## SHA identity

- INITIAL_IMPLEMENTATION_SHA: `9582212d3e840b8cbd4cb5ce778b5d9a651c3588`
- PRE_REWORK_REVIEW_TARGET: `4c8e792eb34912f4637af855d2f2f5b217f8489f`
- REWORK_IMPLEMENTATION_SHA: `a10ba5398a96ca779850c61e002e28a236ba17be`
- REVIEW_TARGET: (evidence-only tip after this evidence commit)
