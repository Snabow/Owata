# WP-001 Evidence — Durable Control Core

Recorded: 2026-08-29
Updated: 2026-08-29 (REWORK R1 — WP001-IR-001 / WP001-IR-002)

## Baseline

- Source branch: `main`
- Baseline HEAD: `39d4fd36d315a7870e09c73e54196c606a426822`
- Implementation branch: `wp-001/durable-control-core`
- Parent review target: `eb74b5ff0aa584b2aa3b8d604239e1a0426c561d`
- `wip/environment-setup` not merged

## SQLite dependency choice

**Chose Node.js built-in `node:sqlite` (`DatabaseSync`).**

Why:

- Zero new npm dependency / no native addon build
- Synchronous API fits atomic claim transactions
- Requires Node **`>=22.13.0`** (unflagged `node:sqlite`; no `--experimental-sqlite`)

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

## REWORK R1 findings

### WP001-IR-001 (HIGH) — Concurrent JSONL projection duplication

**Correction:** `flushEventJsonl()` now runs the full read-existing → select-pending → append-missing → mark-flushed sequence inside `BEGIN IMMEDIATE` / `COMMIT` (SQLite cross-process write lock). Append-only JSONL preserved; SQLite remains authoritative. Crash-after-append before COMMIT still converges on restart via event_id presence check (no re-append).

**Regression:**

- Case A: 1 pending event, 8 processes → target `event_id` appears exactly once
- Case B: 200 pending + seeded events, 8 processes → line count = unique IDs; no dups/losses
- Sequential crash-gap test remains green

### WP001-IR-002 (MEDIUM) — Incorrect Node runtime floor

**Correction:**

- `package.json` engines: `>=22.13.0`
- `package-lock.json` root engines: `>=22.13.0`
- Evidence updated (this file)

No `--experimental-sqlite` compatibility path; no alternate SQLite library.

## Build / tests

```text
$ npm test
20 pass / 0 fail

$ npm run build
exit 0

$ git diff --check
exit 0
```

Includes:

- WP-000 state-directory / CLI regressions
- Control Core persistence, claim, concurrency, fencing, recovery, events
- Forced process-interruption crash recovery
- Multi-process JSONL flush serialization (WP001-IR-001)

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
