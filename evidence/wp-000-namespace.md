# WP-000 Namespace Evidence

Recorded: 2026-08-29

## npm package `owata`

Command:

```bash
npm view owata --json
```

Result: HTTP 404 Not Found from `https://registry.npmjs.org/owata`

Cross-check:

```text
GET https://registry.npmjs.org/owata → 404 {"error":"Not found"}
```

Availability: **AVAILABLE**

Notes:

- CLI binary name remains `owata` regardless of publish plan.
- No rename and no scoped-package decision made in WP-000.

## GitHub repository `Snabow/owata`

Command:

```bash
gh api repos/Snabow/owata
```

Result: HTTP 404 Not Found

User `Snabow` exists. Repository `Snabow/owata` does not exist.

Availability: **AVAILABLE**

Remote creation: **HUMAN_ACTION_REQUIRED**

Reason: creating the remote repository requires a public/private visibility decision that is not fixed by existing WP-000 / Genesis Charter policy. Local repository, CLI, tests, Genesis commit, and Genesis tag proceed without remote creation.
