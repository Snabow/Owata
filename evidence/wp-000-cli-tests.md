# WP-000 CLI Test Evidence

Recorded: 2026-08-29

## Linked CLI

```text
$ owata --version
owata 0.0.1-genesis
exit code: 0

$ owata doctor
[PASS] Runtime
[PASS] Git
[PASS] State directory
OWATA is ready.
exit code: 0

$ owata status
Project: OWATA
State: Genesis
Next: Bootstrap control core
exit code: 0
```

## Direct node invocation

```text
$ node dist/cli.js --version
owata 0.0.1-genesis
exit code: 0

$ node dist/cli.js doctor
[PASS] Runtime
[PASS] Git
[PASS] State directory
OWATA is ready.
exit code: 0

$ node dist/cli.js status
Project: OWATA
State: Genesis
Next: Bootstrap control core
exit code: 0
```

## Clean install

```text
$ Remove-Item -Recurse -Force node_modules
$ npm install
$ npm run build
$ owata --version
owata 0.0.1-genesis
exit code: 0
$ owata doctor
[PASS] Runtime
[PASS] Git
[PASS] State directory
OWATA is ready.
exit code: 0
$ owata status
Project: OWATA
State: Genesis
Next: Bootstrap control core
exit code: 0
```
