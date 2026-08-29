# WP-000 Remote Verification Evidence

Recorded: 2026-08-29

## Remote configuration

```text
$ git remote -v
origin	https://github.com/Snabow/Owata.git (fetch)
origin	https://github.com/Snabow/Owata.git (push)
```

## Required verification at Genesis push

```text
$ git status
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean

$ git rev-parse HEAD
5a89de0ffec8a6c267261bd4d8243ffa74fb3edc

$ git rev-parse origin/main
5a89de0ffec8a6c267261bd4d8243ffa74fb3edc

$ git rev-list -n 1 genesis
5a89de0ffec8a6c267261bd4d8243ffa74fb3edc

$ git rev-parse 'genesis^{commit}'
5a89de0ffec8a6c267261bd4d8243ffa74fb3edc

$ git ls-remote origin refs/heads/main refs/tags/genesis
5a89de0ffec8a6c267261bd4d8243ffa74fb3edc	refs/heads/main
82165f97d09d19ba851943b0ade742adddf55587	refs/tags/genesis
```

`refs/tags/genesis` is an annotated tag object `82165f97d09d19ba851943b0ade742adddf55587` whose target commit is `5a89de0ffec8a6c267261bd4d8243ffa74fb3edc`.

## Remote contents (GitHub API at Genesis push)

Paths present on `main` at Genesis:

```text
.gitignore
Project-OWATA-Genesis-Charter.md
README.md
evidence/wp-000-cli-tests.md
evidence/wp-000-namespace.md
package-lock.json
package.json
src/cli.ts
tsconfig.json
```

Subsequent evidence commits on `main` add/update:

```text
evidence/wp-000-remote.md
evidence/wp-000-namespace.md
```

`genesis` was not moved by evidence commits.

## Confirmation checklist

- GitHub repository contains WP-000 files: YES
- Remote HEAD matches intended local HEAD: YES
- `genesis` exists remotely: YES
- `genesis` resolves to intended Genesis commit: YES (`5a89de0ffec8a6c267261bd4d8243ffa74fb3edc`)
