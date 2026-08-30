# WP-003-STATUS — Durable-state-backed `owata status`

**Work Package:** WP-003-STATUS
**Request:** OWATA-REQ-0062
**Closes blocker:** C08_DURABLE_STATUS_VIEW
**WP003_DONE:** NO (pending Independent Review + Program Control closure)
**C08_ACCEPTED:** NO

## Requirement

Replace the WP-000 hardcoded Genesis stub:

```text
State: Genesis
Next: Bootstrap control core
```

with a minimum truthful `owata status` backed by existing SQLite control state.

## Source of truth

Runtime status authority: existing `control.sqlite` under `OWATA_STATE_DIR` via `ControlStore` / `HandoffStore`.

Does **not** encode B1/B2 milestone labels into CLI semantics.

## Implementation

| Item | Path |
| --- | --- |
| Status read model | `src/status.ts` |
| CLI wiring | `src/cli.ts` (`runStatus`) |
| Newest-first project list | `ControlStore.listProjectsNewestFirst` |
| Newest-first cycle list | `HandoffStore.listCyclesNewestFirst` |
| Tests | `src/status.test.ts` |

## Absence behavior

If `<OWATA_STATE_DIR>/control.sqlite` does not exist:

- print `Durable state: ABSENT` / `Status: NO_DURABLE_STATE`
- exit 0
- **do not** create `control.sqlite`, WAL files, or `events.jsonl`

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

- `npm test` / `npm run build` — PASS (see RESULT)
- Isolated `OWATA_STATE_DIR` CLI proofs for ABSENT and PRESENT
- No external model invocations

## Identity

- **NEW_IMPLEMENTATION_SHA:** `a547bf96f7e62c8e5489dda21ec9baefaf3ef300`
- **NEW_IMPLEMENTATION_TREE_SHA:** `29c780b816c075a01f954ebc54b0f9278412aa14`
- **Parent audit tip:** `30f745b2fbc349095ad7b14aa4d2f0f1dee8a609`
