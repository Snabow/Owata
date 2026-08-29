# WP-002 Evidence — Single Worker Completion Loop

Recorded: 2026-08-29 (REWORK R2)

## Baseline

- `main @ 8f6d7387085e2e012f1f2bd698482cbd68e14b8a`
- Branch: `wp-002/single-worker-completion-loop`
- Prior R1 candidate: `1e2ef5926596d3d9c828a42e43a7969ce6a7fa5e`
- WP-001 history not rewritten

## Worker loop

Production module: `src/worker/loop.ts` (`runOnce` / `runOwnedWork`)

```text
claim (WP-001 lease)
→ beginExecutionAttempt
→ resolve durable execution spec / handler (SETUP_ERROR on failure)
→ task.execute (catch → EXEC_ERROR → finalize → failWork)
→ task.verify (catch → VERIFY_ERROR → finalize → failWork)
→ finishExecutionAttempt (durable; attempt_outcome combined gate)
→ COMPLETED only if latest attempt is finished PASS (execution_ok + verify PASS + outcome PASS)
→ VERIFY FAIL → applyRepair(attempt_id) when budget remains
→ repair() throw → failWork (repair_error) without incrementing repair_count
→ else failWork → FAILED (terminal)
```

## Attempt outcomes (R2 contract)

```text
PASS         = execution_ok === true AND verification_status === PASS
FAIL         = finished execute/verify path but overall gate failed
               (includes execution_ok=false + verification PASS)
SETUP_ERROR  = durable spec/handler preparation failed before execute
EXEC_ERROR   = execute threw
VERIFY_ERROR = verify threw
ABANDONED    = ownership ended before final classification
```

Raw verifier result is preserved independently of `attempt_outcome`.

## Completion gate (WP002-IR-001 + WP002-IR-008)

- `finishExecutionAttempt` sets `attempt_outcome=PASS` only for the combined gate.
- `completeWork` inspects the highest `attempt_number` overall (finished or not).
- Completion requires that exact latest attempt: finished, `execution_ok`, verify PASS, outcome PASS.
- Older PASS never authorizes completion when a newer attempt exists.

## Terminal FAILED (WP002-IR-003 / IR-006 / IR-007)

Work state `FAILED`: not claimable, not requeued, lease cleared, durable `failure_reason`.

R2 additions:

- `repair_error:<bounded message>` when `handler.repair()` throws under valid lease
- `setup_error:<bounded message>` for missing spec / unknown task type after attempt start

## Repair provenance (WP002-IR-004)

Unchanged: `applyRepair` requires finished verification-FAIL attempt_id linkage.

## Schema (WP002-IR-005)

Unchanged: `SCHEMA_VERSION = 3`; exact 1→2→3; version 0 and future rejected.
`SETUP_ERROR` is a value in existing `attempt_outcome` TEXT — no schema bump.

## Proving scenario

`sum_two` with `{a:2,b:3,expected:5,bug:true}`:

1. Attempt 1 → sum 6 → VERIFY FAIL → outcome FAIL
2. Repair linked to that attempt
3. Attempt 2 → sum 5 → VERIFY PASS → outcome PASS → COMPLETED

## Crash / restart

- Crash after claim: unfinished → ABANDONED; same `work_id` recovered
- Crash after repair: repaired input persists; recovery continues

## Tests

```text
$ npm test
38 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 8f6d7387085e2e012f1f2bd698482cbd68e14b8a..HEAD
exit 0
```

Includes WP-000 + WP-001 regressions and WP-002 R1/R2 cases.

## Scope

No LLM/provider/Codex/Cursor/router/Web UI/Phase 3 integrations.
