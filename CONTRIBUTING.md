# Contributing

Guide for developing, versioning, and publishing `@octabits-io` packages.

## Setup

```bash
pnpm install        # installs deps + activates git hooks via "prepare"
```

Requires:
- Node.js 20+
- pnpm 10.5+
- Docker (for integration tests)

## Development workflow

### Build, test, typecheck

```bash
# All packages (via Turborepo)
pnpm build
pnpm test
pnpm typecheck

# Single package
pnpm --filter @octabits-io/foundation build
pnpm --filter @octabits-io/foundation test

# Single test file (from package directory)
cd drizzle-toolkit && npx vitest run --project unit
cd drizzle-toolkit && npx vitest run --project integration   # requires Docker
```

### Commit conventions

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/). This is enforced by a `commit-msg` git hook (commitlint + simple-git-hooks).

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

Common types:

| Type       | When to use                             |
|------------|-----------------------------------------|
| `feat`     | New feature                             |
| `fix`      | Bug fix                                 |
| `docs`     | Documentation only                      |
| `refactor` | Code change that neither fixes nor adds |
| `test`     | Adding or updating tests                |
| `chore`    | Tooling, CI, dependencies               |
| `perf`     | Performance improvement                 |

Examples:

```bash
git commit -m "feat(workflow): add retry policy to step execution"
git commit -m "fix(pii): handle empty plaintext in encrypt"
git commit -m "chore: update drizzle-orm to v0.40"
```

## Versioning and publishing

We use [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs.

All four packages are **linked** — when one package bumps to a new version, the others that also have changesets will share the same version number. Packages without changesets are not published.

### Step 1: Add a changeset

After making changes that should be released, run:

```bash
pnpm changeset
```

This launches an interactive prompt:

1. **Select packages** — pick which packages your change affects
2. **Choose bump type** — major / minor / patch for each
3. **Write a summary** — describe the change for the changelog

This creates a markdown file in `.changeset/` (e.g. `.changeset/cool-dogs-fly.md`). Commit it alongside your code:

```bash
git add .changeset/cool-dogs-fly.md
git commit -m "feat(workflow): add retry policy"
```

> You can add multiple changesets before releasing. They accumulate and are consumed together.

### Step 2: Version packages

When ready to release, consume all pending changesets:

```bash
pnpm changeset:version
```

This:
- Bumps `version` in each affected `package.json`
- Updates `CHANGELOG.md` in each affected package
- Removes the consumed `.changeset/*.md` files
- Updates internal dependency versions if needed

Review the changes, then commit:

```bash
git add -A
git commit -m "chore: version packages"
```

### Step 3: Publish to npm

```bash
pnpm changeset:publish
```

This builds all packages (via Turborepo) then publishes the ones with new versions to npm.

> Make sure you are authenticated with npm (`npm login`) and have publish access to the `@octabits-io` scope.

After publishing, push the version commit and tags:

```bash
git push --follow-tags
```

### Quick reference

```bash
pnpm changeset              # add a changeset (interactive)
pnpm changeset:version      # bump versions + update changelogs
pnpm changeset:publish      # build + publish to npm
```

## Package overview

| Package | Description | Exports |
|---------|-------------|---------|
| `@octabits-io/foundation` | Result types, IoC container, logger, utilities | `./result` `./ioc` `./logger` `./utils` |
| `@octabits-io/drizzle-toolkit` | Database helpers, DAG workflow engine | `./db` `./workflow` |
| `@octabits-io/pii` | PII encryption (AES-256-GCM, X25519+ChaCha20) | `.` |
| `@octabits-io/drizzle-test` | Test utilities with testcontainers for PostgreSQL | `.` |

Dependency graph: `drizzle-toolkit` → `foundation` (peer), `pii` → `foundation` (peer), `drizzle-test` is standalone.
