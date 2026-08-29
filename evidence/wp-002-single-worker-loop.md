# WP-002 Evidence — Single Worker Completion Loop

Recorded: 2026-08-29 (REWORK R3)

## Baseline

- `main @ 8f6d7387085e2e012f1f2bd698482cbd68e14b8a`
- Branch: `wp-002/single-worker-completion-loop`
- Prior R2 candidate: `103b66a4e29f8d74256adc76cf2204ade1c72e7d`
- WP-001 history not rewritten

## Worker loop

Production module: `src/worker/loop.ts` (`runOnce` / `runOwnedWork`)

```text
claim
→ beginExecutionAttempt (work.attempt_started)
→ resolve durable execution spec / handler
    → SETUP_ERROR → work.attempt_finished only → FAILED
→ recordExecutionStarted (work.execution_started)
→ task.execute / verify
→ finish or finalize (execution + attempt finished events as appropriate)
→ COMPLETED | repair | FAILED
```

## Attempt outcomes

```text
PASS | FAIL | SETUP_ERROR | EXEC_ERROR | VERIFY_ERROR | ABANDONED
```

PASS requires `execution_ok === true` AND verification PASS.

## Event semantics (WP002-IR-007)

Attempt lifecycle:

- `work.attempt_started`
- `work.attempt_finished`

Execution lifecycle (only when `execute()` is actually invoked):

- `work.execution_started` via `recordExecutionStarted`
- `work.execution_finished`

SETUP_ERROR emits attempt started/finished and does **not** emit execution started/finished.

## Completion gate

- Combined outcome PASS only for true+PASS
- `completeWork` uses highest `attempt_number` overall

## Repair processing (WP002-IR-009)

Obtain repair → read/validate `nextInput`/`note` → `applyRepair` is one boundary.

Non-fencing failures → `failWork(repair_error:…)` with valid lease.

`STALE_LEASE` is never swallowed or converted into terminal mutation.

## Terminal FAILED

Not claimable, not requeued. Covers budget exhaustion, setup/repair/execution/verify errors, completion-gate rejection.

## Schema

`SCHEMA_VERSION = 3`; exact 1→2→3; unsupported versions rejected.

## Proving scenario

fail → linked repair → pass → COMPLETED

## Tests

```text
$ npm test
44 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 8f6d7387085e2e012f1f2bd698482cbd68e14b8a..HEAD
exit 0
```

## Scope

No LLM/provider/Codex/Cursor/router/Web UI/Phase 3 integrations.
