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
cd packages/foundation && npx vitest run src/result/types.test.ts

# queue splits unit vs integration (integration requires Docker)
cd packages/queue && pnpm test:integration  # pg-boss against real Postgres
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
git commit -m "feat(queue): add retry policy to worker registration"
git commit -m "fix(foundation): handle empty plaintext in pii encrypt"
git commit -m "chore: update drizzle-orm to v0.40"
```

## Versioning and publishing

We use [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs.

All packages version **independently** (the former `linked` group was dissolved when `pii` and `drizzle-toolkit` were folded into `foundation`). Packages without changesets are not published.

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

### One-command release

`scripts/release.sh` orchestrates the whole flow with safety gates
(preflight → quality gates → version → commit → push → publish → push tags):

```bash
pnpm release            # interactive: prints the plan, asks to confirm
pnpm release --yes      # non-interactive
pnpm release --dry-run  # run every gate + show the version plan, change nothing
```

### Quick reference

```bash
pnpm changeset              # add a changeset (interactive)
pnpm changeset:version      # bump versions + update changelogs
pnpm changeset:publish      # build + publish to npm
pnpm release                # all of the above with safety gates
```

## Package overview

| Package | Description | Exports |
|---------|-------------|---------|
| `@octabits-io/foundation` | Result types, IoC container, logger, utilities, config-schema fragments, RBAC, JWT/API-key auth, scoped signing, Vault loader, captcha contract + ALTCHA, PII encryption, Drizzle helpers, iCal ingestion | `./result` `./ioc` `./logger` `./utils` `./config-schema` `./rbac` `./auth` `./signing` `./vault` `./captcha` `./captcha/altcha` `./pii` `./drizzle/*` `./ical` |
| `@octabits-io/elysia` | Elysia middleware & helpers (security headers, client IP, errors, rate limit, app skeleton + graceful shutdown, health routes, env-config helpers) + MCP harness | `.` `./mcp` |
| `@octabits-io/queue` | pg-boss queue base (BossManager, declarative queue/worker/DLQ trio; system + scoped payload bases) | `.` |
| `@octabits-io/storage` | Namespaced blob storage contract + S3-compatible/Postgres providers | `.` `./s3` `./postgres` |
| `@octabits-io/mail` | Mail transport contract + transactional dispatch layer + providers | `.` `./smtp` `./mailjet` `./brevo` |

Dependency graph: `elysia`, `queue`, `storage`, and `mail` declare `foundation`
as a **peer** (its `Result`/`OctError`/`Logger` types appear in their public
APIs). Heavy/vendor deps are peer or optional-peer everywhere (aws-sdk,
drizzle-orm, pg, pg-boss, nodemailer, jose, …); `foundation`'s only hard
deps are the tiny zero-dep `@noble/*`/`@scure/base` crypto primitives. The former
standalone `pii`, `drizzle-toolkit`, `ical`, `captcha`, and `vault` packages
were folded into `foundation` as subpath exports and deprecated on npm. The
durable workflow engine `@octabits-io/flow` moved to its own repository,
[octabits-io/flow](https://github.com/octabits-io/flow) (2026-07-14).
