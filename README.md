**OWATA is an autonomous development platform that gets unfinished projects to done.**

## What OWATA is

OWATA finishes unfinished projects without increasing human cognitive cost. It is not a code generator; it is a role-based, evidence-driven autonomous development platform that moves work from intent to completion.

## Current status: Genesis

Project OWATA is in **Genesis**. Namespace, repository bootstrap, and the minimum CLI entrypoint are the current scope. Control plane features are not implemented yet.

## CLI usage

```bash
owata --version
owata doctor
owata status
```

Expected Genesis output:

```text
$ owata --version
owata 0.0.1-genesis

$ owata doctor
[PASS] Runtime
[PASS] Git
[PASS] State directory
OWATA is ready.

$ owata status
Project: OWATA
State: Genesis
Next: Bootstrap control core
```

## Development status

- Project name: `OWATA`
- CLI command: `owata`
- Version: `0.0.1-genesis`
- Stack: TypeScript / Node.js / Git
- Control Core, providers, queue, orchestrator, and web UI are out of scope for Genesis

## Next: Control Core

The next Work Package is **Control Core** (project/work state, durable persistence, event log, queue, state transition, orphan detection).
