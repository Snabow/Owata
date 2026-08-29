# WP-000 Namespace Evidence

Recorded: 2026-08-29
Updated: 2026-08-29 (remote completion)

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

## GitHub repository

Initial check target was `Snabow/owata` (404 / AVAILABLE).

Human created:

```text
https://github.com/Snabow/Owata
```

(private, empty at creation time)

Status: **CREATED**

Remote: `origin` → `https://github.com/Snabow/Owata.git`

`main` and annotated tag `genesis` pushed successfully.
