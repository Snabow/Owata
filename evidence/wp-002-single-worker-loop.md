# WP-002 Evidence — Single Worker Completion Loop

Recorded: 2026-08-29 (REWORK R5)

## Baseline

- `main @ 8f6d7387085e2e012f1f2bd698482cbd68e14b8a`
- Branch: `wp-002/single-worker-completion-loop`
- Prior R4 candidate: `9e555dac60cb1556f1b96ca01864269cb85b93eb`
- WP-001 history not rewritten

## Event contract

```text
event_id  = identity
event_seq = authoritative causal/projected ordering
ts        = observational metadata
```

SQLite is the authoritative event store.

JSONL is a durable projection of SQLite events:

- ordinary runtime operation remains append-only
- schema migration MAY perform a one-time atomic projection rebuild to establish a new projection contract/order
- after rebuild, append-only behavior resumes

## Schema v4 + R5 projection reconciliation (WP002-IR-007)

Migration `3→4`:

1. backfill unique `event_seq` in SQLite (`ts ASC, event_id ASC` for legacy rows)
2. atomically rebuild `events.jsonl` from SQLite `ORDER BY event_seq ASC` (temp + rename)
3. mark all events `jsonl_flushed=1`
4. bump schema version to 4

On every open at schema v4, projection is reconciled if JSONL does not exactly match SQLite `event_seq` order (crash convergence).

## Result persistence (WP002-IR-010)

Non-serializable execution results → `RESULT_ERROR` → `FAILED`; no recyclable RUNNING.

## Attempt outcomes

```text
PASS | FAIL | SETUP_ERROR | EXEC_ERROR | VERIFY_ERROR | RESULT_ERROR | ABANDONED
```

## Schema

`SCHEMA_VERSION = 4` (exact chain `1→2→3→4`)

## Tests

```text
$ npm test
50 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 8f6d7387085e2e012f1f2bd698482cbd68e14b8a..HEAD
exit 0
```

Includes real legacy v3 divergent-JSONL migration and interrupted-rebuild reopen convergence.

## Scope

No LLM/provider/Codex/Cursor/router/Web UI/Phase 3 integrations.
