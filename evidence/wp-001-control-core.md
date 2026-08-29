# WP-001 Evidence — Durable Control Core

Recorded: 2026-08-29

## Baseline

- Source branch: `main`
- Baseline HEAD: `39d4fd36d315a7870e09c73e54196c606a426822`
- Implementation branch: `wp-001/durable-control-core`
- `wip/environment-setup` not merged

## SQLite dependency choice

**Chose Node.js built-in `node:sqlite` (`DatabaseSync`).**

Why:

- Zero new npm dependency / no native addon build
- Synchronous API fits atomic claim transactions
- Available on the project runtime (Node 24; engines raised to `>=22.5.0`)

No ORM.

## Layout

| Path | Role |
| --- | --- |
| `~/.owata/control.sqlite` (or `$OWATA_STATE_DIR/control.sqlite`) | Authoritative state |
| `~/.owata/events.jsonl` | Append-only event projection |
| `src/control/*` | Control Core implementation |
| `work-packages/WP-001.md` | Durable Work Package handoff |
| `evidence/wp-001-control-core.md` | This evidence |

## State model

Project: `ACTIVE`  
Work: `QUEUED` → `RUNNING` → `COMPLETED`; `RUNNING` → `QUEUED` on lease recovery.

## Build / tests

```text
$ npm test
18 pass / 0 fail

$ npm run build
exit 0
```

Includes:

- WP-000 state-directory / CLI regressions
- Control Core persistence, claim, concurrency, fencing, recovery, events
- Forced process-interruption crash recovery (`claim-and-hold` child killed, same `work_id` reclaimed and completed)

## Crash test (summary)

1. Create project + QUEUED work in temp state dir  
2. Spawn `claim-and-hold` child → claims (RUNNING)  
3. Kill child (`SIGKILL`) before completion  
4. Wait for short lease expiry  
5. New `ControlStore` recovers → same `work_id` QUEUED  
6. Re-claim + complete → COMPLETED  

Result: PASS

## Scope check

No AI providers, routers, Web UI, GitHub orchestration, Phase 2 worker loop, or brokers introduced.
