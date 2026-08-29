# WP-003 Slice 1 Evidence — Protocol + Durable Cycle + Dispatcher

Recorded: 2026-08-29

## Baseline

- `main @ 77403964859acaa70fc97affeb79d9ae37bb8905`
- Branch: `wp-003/slice-1-control-protocol`
- Architecture: `decisions/DEC-003-001-wp003-architecture.md` (unchanged)
- WP-003 is **not** complete; this is Slice 1 only

## Candidate SHA

`3a47d18a2561a496b901eac87a0518770c9a94de`

## Schema v5

Exact migration chain remains `1→2→3→4→5`.

Fresh databases migrate through the chain to v5. Real v4 rows (projects, work, attempts, events, JSONL) survive. Unknown version 0 and future versions still fail explicitly. Reopen is idempotent.

New tables (minimum, not a second job platform):

- `cycles` — identity, Work Package ref, semantic state, candidate SHAs, durable transition policy, retry budget
- `envelopes` — append-only canonical `owata.handoff/1` envelopes
- `dispatches` — request-scoped attempt / fence / lease ownership
- `human_gates` — durable Human Gate + response

WP-002 worker-loop `FAILED` semantics are unchanged.

## Protocol v1

Identifier: `owata.handoff/1`

Families: Control Request, Builder Result, Reviewer Result, Program Control Decision, Human Gate / Response.

Runtime `parseCanonicalEnvelope` is required before cycle mutation. Credential-like field names are rejected. Natural-language prompts are not canonical state.

## Cycle state model

```text
AWAITING_PC
DISPATCHING_BUILD
DISPATCHING_REVIEW
HUMAN_GATE
RECOVERY_REQUIRED
ACCEPTED
ABORTED
```

Standing policy `on_builder_candidate = DISPATCH_REVIEW` is persisted on the cycle and is the only automatic Builder→Reviewer transition. Reviewer REWORK/PASS always returns to Program Control. Dispatcher does not interpret findings or approve Builder output.

## Ownership / lease / fencing

WP-001 `work_items` claim/lease is **not** reused as the role-dispatch queue. Mixing role dispatch into worker QUEUED/RUNNING would distort WP-002 execution semantics.

Slice 1 adds **minimal dispatch-specific ownership** that copies the WP-001 pattern (BEGIN IMMEDIATE-style store transactions, fence token, lease expiry, recover-then-retry):

- `request_id` is the logical dispatch identity (retries keep it)
- `attempt_number` + `fence_token` change on retry
- only the current CLAIMED fence may accept a result
- expired leases become EXPIRED; a new attempt may be claimed
- an already ACCEPTED request cannot be claimed or accepted again
- retry-budget exhaustion → `RECOVERY_REQUIRED` (not ABORT)

## Full fake cycle

Program Control BUILD → Builder `sha-a` → policy DISPATCH_REVIEW → Reviewer REWORK `WP003-TEST-001` → Program Control REWORK scoped to that finding → Builder `sha-b` → Reviewer PASS at `sha-b` → Program Control HUMAN_GATE → Control Core answer ACCEPT → cycle ACCEPTED.

Reopen from SQLite reconstructs envelopes, SHAs, and event_seq/JSONL parity.

## Process interruption

Fixture `claim-dispatch-and-hold` claims the current request and holds. Parent kills the process, lease expires, reopen recovers from SQLite, same `request_id` is retried under attempt 2 / new fence. The dead child's fence cannot complete.

## Replay / stale / preflight

- Duplicate envelope_id with same body is idempotent; second claim after accept is `ALREADY_ACCEPTED`
- Reviewer result for the wrong target SHA → `RESULT_STALE`; cycle stays DISPATCHING_REVIEW
- Missing capability → preflight, invocation count 0, `CAPABILITY_BLOCK`, `RECOVERY_REQUIRED`
- Malformed adapter output → `RESULT_INVALID`
- Stale fence cannot write `sha-stale` over the live candidate
- Exhausted dispatch retries → `RECOVERY_REQUIRED`; only an explicit Program Control Decision ABORT terminals the cycle

## Tests

```text
$ npm ci --ignore-scripts
exit 0

$ npm ls --all
owata@0.0.1-genesis
+-- @types/node@22.20.1
| `-- undici-types@6.21.0
`-- typescript@5.9.3

$ npm test
64 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 77403964859acaa70fc97affeb79d9ae37bb8905..HEAD
exit 0
```

Pre-existing WP-000 / WP-001 / WP-002 tests remain green.

## Provider integration

**NONE.** No ChatGPT, Cursor, Codex, ACP, OpenHands, or other real agent/provider calls. No new npm dependencies. No credential files. Fake adapters live under `src/control/fixtures/`.
