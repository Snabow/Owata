# WP-003-STATUS — Durable-state-backed `owata status`

**Work Package:** WP-003-STATUS
**Requests:** OWATA-REQ-0062 (implement), OWATA-REQ-0064 / 0066 (fail-closed repairs), OWATA-REQ-0067 (final IR)
**Closes blocker:** C08_DURABLE_STATUS_VIEW
**WP003_DONE:** YES
**C08_ACCEPTED:** YES
**Program Control acceptance:** OWATA-REQ-0068
**Final review:** OWATA-REQ-0067 PASS / READY
**Final reviewed target:** `40b393df32dac953aae8676f1523f2a8d57d1b79`
**Final source:** `22ab131d1099954e4f4ae8b03a5692719606bb8f`
**F001:** RESOLVED
**Final tests:** 186/186 PASS
**Build:** PASS
**Diff check:** PASS

Main does **not** yet contain this closure candidate tip. Authoritative main before merge: `32600ac6272010b130d4266628867ae8bd1516da`.

## Requirement

Replace the WP-000 hardcoded Genesis stub:

```text
State: Genesis
Next: Bootstrap control core
```

with a minimum truthful `owata status` backed by existing SQLite control state,
and fail closed on malformed/unrecognized existing durable state
(OWATA-REQ-0063-F001 / OWATA-REQ-0065-F001 lineage).

## Source of truth

Runtime status authority: existing `control.sqlite` under `OWATA_STATE_DIR` via
`ControlStore` / `HandoffStore`, after non-destructive recognition preflight.

Does **not** encode B1/B2 milestone labels into CLI semantics.

## Implementation

| Item | Path |
| --- | --- |
| Status read model | `src/status.ts` |
| CLI wiring | `src/cli.ts` (`runStatus`) |
| Existing-DB preflight | `assertRecognizedOwataControlSqlite` in `src/control/db.ts` |
| CycleState runtime parse | `parseCycleState` in `src/control/protocol.ts` (used by `handoff.mapCycle`) |
| Newest-first project list | `ControlStore.listProjectsNewestFirst` |
| Newest-first cycle list | `HandoffStore.listCyclesNewestFirst` |
| Tests | `src/status.test.ts` |

## Absence behavior

If `<OWATA_STATE_DIR>/control.sqlite` does not exist:

- print `Durable state: ABSENT` / `Status: NO_DURABLE_STATE`
- exit 0
- **do not** create `control.sqlite`, WAL files, or `events.jsonl`

## Fail-closed recognition

Before status may call normal `ControlStore.open` / migration on an **existing**
file, preflight verifies read-only:

- readable SQLite
- `schema_meta` with row `id=1`
- schema version in supported migration inputs `1..SCHEMA_VERSION`
- core tables and **version-required columns** (`PRAGMA table_info`)

Malformed cases (zero-byte, random bytes, non-OWATA SQLite, missing meta row,
unsupported version, unknown persisted `cycles.state`, tables present but missing
version-required columns) → exit 1, no PRESENT, no Genesis stub, no `events.jsonl`
/ status-created repair artifacts, no control.sqlite mutation.

Recognized historical OWATA DBs may still use normal migration.

Unknown `cycles.state` values throw `ControlError` at the durable mapping
boundary (`parseCycleState`); they are not coerced into next authority.

## Cycle selection

Most recently updated cycle: `updated_at DESC`, then `cycle_id DESC`.

## Next authority mapping

| Cycle state | Next authority |
| --- | --- |
| AWAITING_PC / DISPATCHING_PC / RECOVERY_REQUIRED | program_control |
| DISPATCHING_BUILD | builder |
| DISPATCHING_REVIEW | reviewer |
| HUMAN_GATE | human |
| ACCEPTED / ABORTED | none |

## Validation

- `npm test` / `npm run build` — PASS (186/186 at OWATA-REQ-0067)
- Isolated `OWATA_STATE_DIR` CLI proofs for ABSENT, PRESENT, and corrupt fail-closed
- No external model invocations for status itself

## Identity / lineage

### OWATA-REQ-0062

- **NEW_IMPLEMENTATION_SHA:** `a547bf96f7e62c8e5489dda21ec9baefaf3ef300`
- **NEW_IMPLEMENTATION_TREE_SHA:** `29c780b816c075a01f954ebc54b0f9278412aa14`
- **Parent audit tip:** `30f745b2fbc349095ad7b14aa4d2f0f1dee8a609`

### OWATA-REQ-0064

- **BASE:** `8ba2ff4f1de4c0e3d70065351cd5e1cee3bdfe23`
- **AUTHORIZED_FINDING:** OWATA-REQ-0063-F001
- **NEW_IMPLEMENTATION_SHA:** `49971f307208990ef1cb8d9c2a3a5569e95ec892`
- **NEW_IMPLEMENTATION_TREE_SHA:** `fea27e86ec2c3dd493fdc15fe6681805a5daa8ad`

### OWATA-REQ-0066

- **BASE:** `d6581992d5b84558a136e21d6b628dd874ed3109`
- **AUTHORIZED_FINDING:** OWATA-REQ-0065-F001
- Strengthens recognition with version-aware required-column checks via `PRAGMA table_info` before `ControlStore.open`.
- **NEW_IMPLEMENTATION_SHA:** `22ab131d1099954e4f4ae8b03a5692719606bb8f`
- **NEW_IMPLEMENTATION_TREE_SHA:** `286ad28739c26da830d9873205df1e3dad9666f7`

### OWATA-REQ-0067 / OWATA-REQ-0068

- **FINAL_REVIEW:** OWATA-REQ-0067 PASS / READY (`C08_READINESS: READY`, FINDINGS: none)
- **FINAL_REVIEW_TARGET:** `40b393df32dac953aae8676f1523f2a8d57d1b79`
- **PROGRAM_CONTROL_CLOSURE:** OWATA-REQ-0068 → `C08_ACCEPTED=YES`, `WP003_DONE=YES`
