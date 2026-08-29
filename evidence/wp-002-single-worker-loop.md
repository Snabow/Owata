# WP-002 Evidence — Single Worker Completion Loop

Recorded: 2026-08-29 (REWORK R4)

## Baseline

- `main @ 8f6d7387085e2e012f1f2bd698482cbd68e14b8a`
- Branch: `wp-002/single-worker-completion-loop`
- Prior R3 candidate: `f4c1c69cb9e7c69a8b12a094e74be4492bb48af4`
- WP-001 history not rewritten

## Event contract (WP002-IR-007)

```text
event_id  = identity
event_seq = authoritative causal/projected ordering
ts        = observational metadata (not the sole sequencer)
```

Schema v4 adds durable monotonic `event_seq` (UNIQUE). Assignment occurs inside `BEGIN IMMEDIATE` via `MAX(event_seq)+1`.

`listEvents()` and JSONL projection both order by `event_seq ASC`. JSONL lines include `event_seq`.

Defined normal lifecycle order:

```text
attempt_started
→ execution_started
→ execution_finished
→ attempt_finished
→ verification_passed | verification_failed
→ repair_applied | completed | failed
```

SETUP_ERROR:

```text
attempt_started → attempt_finished(SETUP_ERROR) → failed
```

(no execution events)

Migration: exact `1→2→3→4`. Existing events are backfilled with contiguous `event_seq` preserving prior `ts,event_id` order.

## Result persistence (WP002-IR-010)

Non-JSON-serializable execution results throw `RESULT_SERIALIZE` before any finish commit.

Worker finalizes `RESULT_ERROR` (execution occurred; result not represented) and `failWork(result_error:…)`.

Offending graph is not persisted. Lease fencing preserved for `STALE_LEASE`.

## Attempt outcomes

```text
PASS | FAIL | SETUP_ERROR | EXEC_ERROR | VERIFY_ERROR | RESULT_ERROR | ABANDONED
```

## Schema

`SCHEMA_VERSION = 4`

## Tests

```text
$ npm test
48 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 8f6d7387085e2e012f1f2bd698482cbd68e14b8a..HEAD
exit 0
```

## Scope

No LLM/provider/Codex/Cursor/router/Web UI/Phase 3 integrations.
