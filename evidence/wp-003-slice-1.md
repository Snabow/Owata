# WP-003 Slice 1 Evidence 窶・Protocol + Durable Cycle + Dispatcher

Recorded: 2026-08-29

## Baseline

- Independent Review target (R0): `992a4d286586bc1eab0776fcc96e2ea79c0f1346`
- Branch: `wp-003/slice-1-control-protocol`
- Architecture: `decisions/DEC-003-001-wp003-architecture.md`
- Execution Gateway direction: `decisions/DEC-003-002-execution-gateway-pattern.md` (**ACCEPTED**, design-only; not implemented in Slice 1)
- WP-003 is **not** complete; this is Slice 1 only

## Candidate SHAs (do not conflate)

| Label | SHA | Meaning |
| --- | --- | --- |
| **INDEPENDENT REVIEW TARGET SHA (R0)** | `992a4d286586bc1eab0776fcc96e2ea79c0f1346` | Slice 1 R0 HEAD reviewed under OWATA-REQ-0023 (REWORK) |
| **IMPLEMENTATION SHA (R1)** | `56934e838e8b2aa7b031c4bd20134d29b2c236c5` | Slice 1 R1 rework resolving the four confirmed findings |
| **INDEPENDENT REVIEW TARGET SHA (R1)** | `a3be07aabe442c803e89b94ae7639113913bf103` | R1 review HEAD; OWATA-REQ-0025 disposition **REWORK** |
| **IMPLEMENTATION SHA (R2)** | `00694824e0186ebf8cd0939901227c1cc46014a0` | Slice 1 R2: F01 policy provenance + F02 PC semantic RETRY + killed-child fence regression |
| **INDEPENDENT REVIEW TARGET SHA (R2)** | `5414686a7864749655d54318efbfab0028d832b4` | R2 review HEAD; OWATA-REQ-0027 disposition **REWORK** (F01 request envelope roles; F02 accepted target; F03 Human Gate) |
| **IMPLEMENTATION SHA (R3)** | `6c867ce46db4a3bf4bca922904722c2ae00e875e` | Slice 1 R3: complete PC request authority + failed-target proof + Human Gate recovery retention |
| **INDEPENDENT REVIEW TARGET SHA (R3)** | `26add9c2f718281fa3e07512e9274d9d6d3d88df` | R3 review HEAD; OWATA-REQ-0030 disposition **REWORK** (F01 recovery lineage provenance) |
| **IMPLEMENTATION SHA (R4)** | *(recorded after R4 land)* | Slice 1 R4: explicit recovery_lineage_id binding + stale-lineage rejection |

Any later evidence-only follow-up that only fills this table is **not** the implementation SHA.

## Slice 1 R1 窶・Independent Review finding resolutions (OWATA-REQ-0024)

All four confirmed findings are addressed in Control Core (fake adapters only; no real providers).

### IR Finding 1 窶・Program Control durable dispatch 窶・RESOLVED

Program Control is no longer a direct `decide()` bypass.

Logical PC requests are persisted with stable `request_id`, capability-preflighted, claimed with lease/fence, invoked only under ownership, runtime-validated, and accepted only while the cycle remains `DISPATCHING_PC`. Stale/late PC attempts cannot mutate already-transitioned state. Process restart retries the same logical `request_id` under a new attempt/fence. Competing Dispatchers cannot apply two semantic PC Decisions.

Cycle state model includes `DISPATCHING_PC`. Builder/Reviewer fencing is not weakened.

### IR Finding 2 窶・Role / adapter authority 窶・RESOLVED

Before any adapter output becomes canonical, the Dispatcher enforces:

| Invocation | Adapter `identity.role` | Accepted envelope |
| --- | --- | --- |
| Program Control | `program_control` | `kind=program_control_decision`, `from_role=program_control` |
| Builder | `builder` | `kind=builder_result`, `from_role=builder`, correlates with `request.to_role=builder` |
| Reviewer | `reviewer` | `kind=reviewer_result`, `from_role=reviewer`, correlates with `request.to_role=reviewer` |

Misbound / malicious schema-valid fakes are rejected before semantic authority. Builder self-approval via a PC Decision envelope is impossible. Adversarial regression tests cover both sides.

### IR Finding 3 窶・Envelope full-identity idempotency 窶・RESOLVED

`canonicalEnvelopeIdentity()` compares the full canonical persisted envelope (protocol, ids, roles, timestamps, body), not `body_json` alone.

- Same `envelope_id` + exact same canonical envelope 竊・idempotent
- Same `envelope_id` + any differing canonical field 竊・`DUPLICATE_ENVELOPE` conflict
- Cross-cycle replay of an `envelope_id` cannot attach another cycle to a foreign envelope
- Distinct `envelope_id` with same body remains a distinct envelope where protocol allows

### IR Finding 4 窶・Automatic review PC provenance 窶・RESOLVED

`createCycle()` rejects unproven `on_builder_candidate = DISPATCH_REVIEW`.

Automatic Reviewer dispatch requires durable Program Control provenance: an accepted PC Decision may `install_policy`, and the cycle records `policy_authorized_by_decision_id`. Dispatcher auto-dispatches review only when `mayAutoDispatchReview()` reconstructs valid provenance from SQLite. Missing/invalid authorization prevents automatic review. Dispatcher still performs no semantic reasoning.

### Process interruption 窶・Program Control

Required R1 coverage: PC request persisted 竊・dispatch claimed 竊・process killed 竊・lease expires 竊・restart 竊・same logical `request_id` 竊・new attempt/fence 竊・stale prior fence cannot apply Decision 竊・cycle continues.

Builder process-kill coverage retained on the common fenced role path.

## Slice 1 R2 窶・OWATA-REQ-0025 finding resolutions (OWATA-REQ-0026)

Baseline / prior review HEAD: `a3be07aabe442c803e89b94ae7639113913bf103`.

### F01 窶・Policy provenance / role authority 窶・RESOLVED

Automatic review authority is not 窶彗 PC-looking envelope exists.窶・It requires an **ACCEPTED Program Control dispatch** whose `result_envelope_id` is the exact Decision, with:

- `kind = program_control_decision`, `from_role = program_control`
- correlated DECIDE/ADJUDICATE Control Request on the same cycle
- Decision `install_policy` exactly matching the authorized cycle policy

`assertPolicyProvenance()` is the single validation path used by both `installPolicyFromDecision()` and `mayAutoDispatchReview()` (revalidated from SQLite after reopen). Pointer `policy_authorized_by_decision_id` alone is not proof.

### F02 窶・Program Control semantic RETRY 窶・RESOLVED

Two distinct retry concepts:

| Kind | Identity | Budget |
| --- | --- | --- |
| **Automatic dispatch retry** | Same `request_id`, new `attempt_number` / fence | Before budget exhaustion |
| **PC semantic RETRY** | **New** Control Request + new `request_id`, `retry_of_request_id` = failed request, authorized by PC RETRY Decision | Fresh automatic budget |

Durable `cycles.recovery_target_request_id` retains the failed Builder/Reviewer request across PC ADJUDICATE setup and process reopen. Creating the PC recovery request does not erase it. RETRY creates a new role request and clears the recovery target. Invalid/missing recovery targets reject RETRY (no stranding on the accepted PC request).

### PC killed-child fence regression 窶・corrected

The committed PC interruption test now seeds `DISPATCHING_PC` without a prior attempt, records the **child process** `dispatch_id`/`fence_token`, and asserts that exact child fence cannot accept after recovery.

## Slice 1 R3 窶・OWATA-REQ-0027 finding resolutions (OWATA-REQ-0028)

Baseline / prior review HEAD: `5414686a7864749655d54318efbfab0028d832b4`.

### F01 窶・Canonical PC Control Request authority 窶・RESOLVED

`assertPolicyProvenance()` now requires the correlated Control Request envelope fields:

- `from_role = dispatcher`
- `to_role = program_control`
- `body.target_role = program_control`
- `body.action = DECIDE | ADJUDICATE`
- `body.expected_result_kind = program_control_decision`

in addition to the accepted PC dispatch + exact `install_policy` match. The OWATA-REQ-0027-F01 exploit (Builder-facing envelope roles with PC body) is a regression.

### F02 窶・Semantic RETRY failed-target proof 窶・RESOLVED

`assertRetryableRecoveryTarget()` proves:

- active recovery lineage (`recovery_reason`)
- pointer match
- Builder/Reviewer canonical request
- **no ACCEPTED dispatch**
- durable failure evidence from dispatches (REJECTED/EXPIRED/RECOVERED) and/or events (`recovery_required` / `capability_blocked` / `result_rejected`)

Accepted requests cannot be replayed via PC RETRY.

### F03 窶・Human Gate preserves recovery target 窶・RESOLVED

Entering `HUMAN_GATE` no longer clears `recovery_target_request_id`. Human RETRY returns to Program Control with the target retained; PC then issues semantic RETRY. ACCEPT/ABORT still clear the target.

### PC semantic RETRY chain (authoritative)

```text
failed Builder/Reviewer request A
竊・durable failure evidence + recovery_target_request_id=A
竊・RECOVERY_REQUIRED
竊・PC ADJUDICATE (P)  [does not erase A]
竊・optional HUMAN_GATE (preserves A) 竊・Human RETRY 竊・AWAITING_PC
竊・PC Decision RETRY
竊・new request B (new request_id, retry_of_request_id=A, authorized_by_decision_id=Decision)
竊・DISPATCHING_BUILD | DISPATCHING_REVIEW
```

Distinct from automatic dispatch retry (same `request_id`, new attempt/fence).

## Schema v5

Exact migration chain remains `1竊・竊・竊・竊・` (no version bump for R2/R3).

Fresh databases migrate through the chain to v5. Real v4 rows survive. Additive columns on open / migrateToV5:

- `cycles.policy_authorized_by_decision_id`
- `cycles.recovery_target_request_id`

Unknown version 0 and future versions still fail explicitly.

Tables:

- `cycles` 窶・identity, Work Package ref, semantic state, candidate SHAs, durable transition policy + PC provenance, recovery target, retry budget
- `envelopes` 窶・append-only canonical `owata.handoff/1` envelopes (Control Request may carry `retry_of_request_id`)
- `dispatches` 窶・request-scoped attempt / fence / lease ownership (PC, Builder, Reviewer)
- `human_gates` 窶・durable Human Gate + response

WP-002 worker-loop `FAILED` semantics are unchanged.

## Protocol v1

Identifier: `owata.handoff/1`

Families: Control Request, Builder Result, Reviewer Result, Program Control Decision (optional `install_policy`), Human Gate / Response.

Runtime `parseCanonicalEnvelope` is required before cycle mutation. Credential-like field names are rejected.

## Cycle state model

```text
AWAITING_PC
DISPATCHING_PC
DISPATCHING_BUILD
DISPATCHING_REVIEW
HUMAN_GATE
RECOVERY_REQUIRED
ACCEPTED
ABORTED
```

Standing policy `on_builder_candidate = DISPATCH_REVIEW` is effective only with durable PC Decision provenance. Reviewer REWORK/PASS always returns to Program Control. Dispatcher does not interpret findings or approve Builder output.

## Ownership / lease / fencing

Dispatch-specific ownership (not WP-001 work queue) applies uniformly to Program Control, Builder, and Reviewer:

- `request_id` is the logical dispatch identity (retries keep it)
- `attempt_number` + `fence_token` change on retry
- only the current CLAIMED fence may accept a result
- expired leases become EXPIRED; a new attempt may be claimed
- an already ACCEPTED request cannot be claimed or accepted again
- retry-budget exhaustion 竊・`RECOVERY_REQUIRED` (not ABORT)

## Full fake cycle

Program Control BUILD (+ install `DISPATCH_REVIEW` provenance) 竊・Builder `sha-a` 竊・Reviewer REWORK `WP003-TEST-001` 竊・Program Control REWORK scoped to that finding 竊・Builder `sha-b` 竊・Reviewer PASS at `sha-b` 竊・Program Control HUMAN_GATE 竊・Control Core answer ACCEPT 竊・cycle ACCEPTED.

Request action sequence: `DECIDE, BUILD, REVIEW, DECIDE, REWORK, REVIEW, DECIDE`.

## Tests (R3)

```text
$ npm ci --ignore-scripts
exit 0

$ npm ls --all
owata@0.0.1-genesis
+-- @types/node@22.20.1
| `-- undici-types@6.21.0
`-- typescript@5.9.3

$ npm test
85 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 5414686a7864749655d54318efbfab0028d832b4..HEAD
exit 0
```

R3 regressions cover F01 forged request envelope roles, F02 accepted-target / no-evidence rejection, and F03 Human Gate recovery retention through reopen 竊・Human RETRY 竊・PC RETRY. Prior suites remain green.

## Slice 1 R4 窶・OWATA-REQ-0030-F01 recovery lineage provenance

Baseline / prior review HEAD: `26add9c2f718281fa3e07512e9274d9d6d3d88df`.

### OWATA-REQ-0030-F01 窶・RESOLVED

Semantic RETRY now requires an explicit durable **recovery lineage**:

- `cycles.recovery_lineage_id` (additive v5 column)
- `enterRecovery()` creates a new lineage id, binds `recovery_target_request_id`, sets `recovery_reason`, and appends authoritative `cycle.recovery_required` with the same identity fields
- `assertRetryableRecoveryTarget()` requires active lineage id, matching durable lineage event (`cycle_id` / `recovery_lineage_id` / `request_id` / `reason`), no ACCEPTED result, and failure evidence compatible with the current lineage
- Historical failure evidence for request A cannot authorize RETRY while the current lineage identifies request B (stale-lineage regression)
- Human Gate preserves both `recovery_target_request_id` and `recovery_lineage_id` through reopen 竊・Human RETRY 竊・PC RETRY
- ACCEPT / ABORT / REDESIGN / successful semantic RETRY clear target + lineage together
- Later genuine recovery supersedes the prior lineage id

### Semantic PC RETRY chain (R4)

```text
Builder/Reviewer failure
竊・enterRecovery(requestId=A)  # new recovery_lineage_id = L-A
竊・RECOVERY_REQUIRED (target=A, lineage=L-A)
竊・PC ADJUDICATE (lineage preserved)
竊・optional HUMAN_GATE (lineage preserved; reopen-safe)
竊・optional Human RETRY 竊・AWAITING_PC (lineage preserved)
竊・PC Decision RETRY
竊・assertRetryableRecoveryTarget (lineage event + failure evidence)
竊・new Control Request B (retry_of_request_id=A, authorized_by_decision_id=RETRY Decision)
竊・clear recovery_target + recovery_lineage
竊・Builder/Reviewer proceeds with fresh dispatch budget
```

### Validation (R4)

```text
$ npm ci --ignore-scripts
$ npm ls --all
$ npm test
91 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0

$ git diff --check 26add9c2f718281fa3e07512e9274d9d6d3d88df..HEAD
exit 0
```

## Provider integration

**NONE.** No ChatGPT, Cursor, Codex, Fable, ACP, OpenHands, or other real agent/provider calls. No new npm dependencies. No credential files. Fake adapters live under `src/control/fixtures/`. Execution Gateway (DEC-003-002) is not implemented.
