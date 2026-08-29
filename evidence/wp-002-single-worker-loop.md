# WP-002 Evidence — Single Worker Completion Loop

Recorded: 2026-08-29

## Baseline

- `main @ 8f6d7387085e2e012f1f2bd698482cbd68e14b8a`
- Branch: `wp-002/single-worker-completion-loop`
- WP-001 history not rewritten

## Worker loop

Production module: `src/worker/loop.ts` (`runOnce` / `runOwnedWork`)

```text
claim (WP-001 lease)
→ beginExecutionAttempt
→ task.execute
→ task.verify
→ finishExecutionAttempt (durable)
→ PASS → completeWork (lease-fenced)
→ FAIL → applyRepair (bounded) → new attempt
```

Completion requires verification PASS. Execution success alone never completes.

## Execution spec

On `work_items` (schema v2):

- `task_type` (e.g. `sum_two`)
- `task_input` JSON
- `repair_count` / `max_repairs`

## Result capture

Table `work_attempts`: attempt_id, work_id, attempt_number, worker_id, timestamps, execution_ok, result_json, verification_status/detail, repair flags.

## Verification / repair

- Verifier is a distinct `TaskHandler.verify` step
- `sum_two` repair clears durable `bug: true` → `bug: false` (material cause change)
- Repair budget enforced in `ControlStore.applyRepair`

## Events

Extended EventType on existing SQLite + JSONL path:

`work.execution_started|finished`, `work.verification_failed|passed`, `work.repair_applied`, plus existing claim/complete/lease events.

## Proving scenario

`sum_two` with `{a:2,b:3,expected:5,bug:true}`:

1. Attempt 1 → sum 6 → VERIFY FAIL  
2. Repair clears bug  
3. Attempt 2 → sum 5 → VERIFY PASS → COMPLETED  

## Crash / restart

Child `run-once` claims and holds; killed; lease expires; recover same `work_id` to QUEUED; new worker completes. Stale token cannot complete.

## At-least-once note

Local sample handlers are safely retryable/idempotent. Exactly-once external side effects are not claimed.

## Dependency

Still `node:sqlite` only; schema migrates 1→2 additively.

## Tests

```text
$ npm test
28 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0
```

Includes WP-000 + WP-001 regressions and WP-002 worker/crash/repair cases.

## Scope

No LLM/provider/Codex/Cursor/router/Web UI/Phase 3 integrations.
