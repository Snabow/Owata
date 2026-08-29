# WP-002 Evidence — Single Worker Completion Loop

Recorded: 2026-08-29 (REWORK R1)

## Baseline

- `main @ 8f6d7387085e2e012f1f2bd698482cbd68e14b8a`
- Branch: `wp-002/single-worker-completion-loop`
- Prior reviewed candidate: `b0d9d46110a62e05102a3cad5f5d09fe784dd8e7`
- WP-001 history not rewritten

## Worker loop

Production module: `src/worker/loop.ts` (`runOnce` / `runOwnedWork`)

```text
claim (WP-001 lease)
→ beginExecutionAttempt
→ task.execute (catch → EXEC_ERROR → finalize → failWork)
→ task.verify (catch → VERIFY_ERROR → finalize → failWork)
→ finishExecutionAttempt (durable)
→ COMPLETED only if execution_ok === true AND verification_status === PASS
→ VERIFY FAIL → applyRepair(attempt_id) when budget remains
→ else failWork → FAILED (terminal)
```

## Completion gate (WP002-IR-001)

Production `completeWork` and worker loop both require:

```text
execution_ok === true AND verification_status === PASS
```

Regression: execute `ok:false` + verify PASS → work reaches `FAILED` with reason `completion_gate:verification_pass_without_execution_ok`; never COMPLETED.

## Attempt outcomes (WP002-IR-002)

Durable `attempt_outcome` on `work_attempts`:

- `PASS` / `FAIL` — verified outcomes
- `EXEC_ERROR` / `VERIFY_ERROR` — handler exceptions finalized under valid lease
- `ABANDONED` — unfinished attempt classified during expired-lease recovery (unknown crash; not claimed as definite execution failure)

Events: `work.attempt_abandoned`, existing execution/verification events, `work.failed`.

## Terminal FAILED (WP002-IR-003)

Work state `FAILED` (extends QUEUED/RUNNING/COMPLETED):

- not claimable by `claimNextWork`
- not requeued by `recoverExpiredLeases`
- lease cleared; `failure_reason` persisted; `work.failed` event
- repair-budget exhaustion → FAILED; repeated `runOnce` performs no new execution

## Repair provenance (WP002-IR-004)

`applyRepair` requires lease + finished attempt with `attempt_outcome`/`verification` FAIL, not already repaired, budget remaining. Atomically updates input, increments `repair_count`, sets `repair_applied`/`repair_note`, emits `work.repair_applied` with `attempt_id`.

## Schema (WP002-IR-005)

`SCHEMA_VERSION = 3`. Exact chain:

- fresh → v1 tables then migrate to current
- `version === 1` → v2 (task/attempt columns)
- `version === 2` → v3 (`failure_reason`, `attempt_outcome`)
- `version === 0` rejected; future versions rejected

## Proving scenario

`sum_two` with `{a:2,b:3,expected:5,bug:true}`:

1. Attempt 1 → sum 6 → VERIFY FAIL
2. Repair linked to that attempt (`repair_applied`, event `attempt_id`)
3. Attempt 2 → sum 5 → VERIFY PASS → COMPLETED

## Crash / restart

- Crash after claim: unfinished attempt → ABANDONED on lease recovery; same `work_id` reclaimed and completed
- Crash after repair: repaired input persists; recovery continues same `work_id`

## At-least-once note

Local sample handlers are safely retryable/idempotent. Exactly-once external side effects are not claimed after crash/ABANDONED.

## Dependency

Still `node:sqlite` only; no ORM.

## Tests

```text
$ npm test
33 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 8f6d7387085e2e012f1f2bd698482cbd68e14b8a..HEAD
exit 0
```

Includes WP-000 + WP-001 regressions and WP-002 R1 cases (completion gate, exceptions, ABANDONED, FAILED, repair provenance, schema gates, crash, fencing).

## Scope

No LLM/provider/Codex/Cursor/router/Web UI/Phase 3 integrations.
