# @octabits-io/framework

## 0.36.0

### Minor Changes

- [`57a42c6`](https://github.com/octabits-io/platform/commit/57a42c6230ef41bc4126762709f1ae7fbd7948b0) - Agents as principals, on the ledger.
  
  `./proposal`: `Principal` (`{ kind, id, label?, onBehalfOf?, authorizationId? }`)
  on `provenance` and on `applied` — who acted, for whom, under which grant; a
  `reversibility` class per operation (`reversible` | `compensable` |
  `irreversible`), honoured by `invertOperations` (irreversible operations are
  named, not undone) and summarised by `reversibilityOf`. Still zod-only.
  
  `./drizzle/agent-ledger` (new): the append-only record of what agents did,
  under whose grant, and how to undo it. `agentLedgerColumns` +
  `createDrizzleAgentLedgerStore` (record / get / findByWorkflow(s) /
  listByActor / markReverted) + an in-memory twin. Deliberately the audit and
  undo log, not event sourcing. Record types are structural duplicates of the
  proposal contract's, so the contract stays a leaf.

- [`5ca2234`](https://github.com/octabits-io/platform/commit/5ca2234e755a805b7f68c6b288be988f777adb05) - Embedded-database (PGlite) support through structural seams — no new peer dependency:
  
  - `./queue`: `createBossManager` takes **either** `connectionString` **or** a pg-boss `db` adapter (`fromPglite(pglite)`, `fromDrizzle(…)`, …) plus an optional `backend` profile, so pg-boss can run on an embedded database or a shared connection instead of its own pool.
  - `./events/pglite` (new subpath): `createPgliteNotifyListener({ pglite, channel })` — the `EventNotificationListener` for an in-process PGlite instance. Structural on the instance; imports nothing from `@electric-sql/pglite`.
  - `./drizzle/broadcast`: `subscribe` accepts a ready `listener` as the alternative to `connectionString`.
  - `./storage/postgres` (**breaking**): the config field `pool: Pool` is now `db: Pool | SqlExecutor` — a `pg` Pool still works; any host that can run parameterized SQL and a transaction (PGlite, an RLS-scoped connection) implements the exported `SqlExecutor` seam directly (same shape as octaflow's). `poolExecutor`/`toExecutor` are exported. `getObjectData` now normalizes `bytea` to a `Buffer` whatever the driver returns.
  - `./drizzle/scope`: the `bytea` column type normalizes driver values to `Buffer` (PGlite returns a plain `Uint8Array`).

- [`9e521d8`](https://github.com/octabits-io/platform/commit/9e521d8315ea9f55d53f0c656fb5af282c1069f1) - `./proposal`: the apply-side helpers — `driftDigest`/`stableStringify` (the
  guard a producer stores and a host recomputes), `detectDrift` (which accepted
  updates would overwrite something other than what the reviewer saw), and
  `invertOperations` (the operations that undo an application, derived from the
  resolved operations and the ids the host assigned to creates — revert as a
  second proposal, computed from the audit row). Still zod-only. `docs/proposal.md`
  gains "The recipe", pointing at the demo server as the reference host.

- [`8cc3970`](https://github.com/octabits-io/platform/commit/8cc3970c1d1719927603ce104364504b5bf63e1d) - Add `@octabits-io/framework/proposal` — the reviewable-outcome contract — and a
  generic `ProposalReviewCard.vue` in the kit that renders it.
  
  A workflow outcome expressed as a **set of operations against data that already
  exists**, rather than a value the caller must interpret. `current` is mandatory
  on anything that replaces something, and is captured on the server at emit
  time, so the diff is a stored, auditable artifact rather than something a
  review surface reconstructs by re-reading the entity in a browser.
  
  Four operations, derived from a survey of real multi-step AI workflows rather
  than guessed:
  
  - **`update`** — field values on an existing entity, optionally across a second
    axis (`variant`) such as locale, addressed by a structured `path` that
    reaches leaves inside nested documents and arrays.
  - **`create`** — new rows, including whole trees. A create declares a `ref`
    that other operations anchor to, so a child can name a parent that does not
    exist yet; `existing` marks a create the producer believes is really a link
    to something the host already has.
  - **`delete`** — removal, carrying what is being removed.
  - **`reorder`** — ordered collections, able to place pending creates among
    existing members.
  
  Supporting pieces: `validateProposal`, `orderOperations`, `resolveDecision`,
  `danglingAfterDecision`, `derivedFrom`, `guard` (drift digest), `skipped[]`,
  optional `display` metadata, and zod schemas for both directions of the wire.
  
  The module depends on nothing but zod, imports no other framework module, and
  no other module imports it (lint-enforced as a leaf), so browsers can import it
  and it can be lifted into its own package later without touching anything else.
  It is deliberately **not** part of octaflow: a proposal is defined against a
  step's output schema, never its execution trace, so any engine can emit one.
  
  The kit's `ProposalReviewCard.vue` renders every operation kind, defaults to
  accepting, and emits a `ProposalDecision`; it needs framework `>=0.36.0` (the
  peer range moves accordingly) and ships its `ai.review.*` messages in
  `kitMessagesEn`.

## 0.35.0

### Minor Changes

- [`1291ba2`](https://github.com/octabits-io/platform/commit/1291ba23a4e924a10c4744105db280cd0f29108e) - queue: expose pg-boss's `reindex` and `reindexIntervalSeconds` on `createBossManager`
  
  pg-boss 12.29 turned index-bloat rebuilds (`REINDEX INDEX CONCURRENTLY` on
  indexes failing a density check) on by default. `BossManagerConfig` declared a
  closed set of options, so a consumer going through the manager — rather than
  constructing `PgBoss` directly — had no way to opt out or tune the thresholds,
  and every `role: 'full'` process is a candidate for the pass.
  
  Both keys are spread conditionally: pg-boss validates them with `'key' in
  config`, so passing them through as `undefined` would trip its config assert
  instead of falling back to the default. Omitting them keeps pg-boss's defaults
  exactly as before.

## 0.34.0

### Minor Changes

- [`fd93cd4`](https://github.com/octabits-io/platform/commit/fd93cd409c77979df29ad047d90923f97db09a95) - queue: wake workers over LISTEN/NOTIFY. `createBossManager` now starts pg-boss with `useListenNotify: true` under role `'full'` (and explicitly `false` under `'producer'`, which runs no workers). A queue opts in with the new `notify: true` in `QueueDomainConfig` / `defineQueue({ config })`: every send on that queue then emits a Postgres NOTIFY in the same transaction as the insert, and workers fetch immediately instead of waiting out `pollingIntervalSeconds`. Polling continues as the correctness floor; when the listener cannot be established pg-boss warns and keeps polling. Requires the direct database URL (no PgBouncer transaction pooling) — which the pg-boss connection already needed.

## 0.33.0

### Minor Changes

- [`99fc21b`](https://github.com/octabits-io/platform/commit/99fc21b5ed172bb86b33522581d2610b6283dd7f) - zitadel: user lifecycle calls and an instance-wide grant index
  
  - `deactivateUser` / `reactivateUser` / `deleteUser` — the reversible lock and
    the irreversible delete, previously absent, so a consumer could revoke a
    user's grants but never touch the account itself.
  - `listAllUserGrants()` — every grant on the instance in one pass over the
    orgs, the inverse index to the per-user `listUserGrants`. Costs `orgs`
    requests where asking per user costs `users × orgs`. Pages each org's search
    (the single-org helpers take Zitadel's default page size and stop there), and
    reports per-org failures in `failedOrgIds` instead of dropping them, so a
    caller acting on "this user holds no grant" can refuse when the real answer
    is "we could not ask".
  - `ZitadelUser.type` — `human` | `machine` | `unknown`. Service accounts hold
    no project grants by nature, so without this they are indistinguishable from
    abandoned human accounts to any grant-based staleness test.

### Patch Changes

- [`f1d222d`](https://github.com/octabits-io/platform/commit/f1d222d8b5b3e09ece0be74d77e1ddef7bd28d1c) - queue: keep the queue-ensure step compatible with pg-boss 12.28's nullable queue options
  
  pg-boss 12.28 widened `UpdateQueueOptions` so `deadLetter`, `retryDelayMax` and
  `heartbeatSeconds` accept `null` — the "clear this setting" signal `updateQueue`
  understands. `createQueue` still takes `Omit<Queue, 'name'>`, where those three
  are non-nullable, so `ensureQueueSynced` passing one options object to both no
  longer typechecked.
  
  The nulls are now dropped on the create leg only: on a queue that does not exist
  yet, "clear it" and "never set it" are the same thing, and the `updateQueue` call
  right after applies the clear for real on an existing queue. No behavior change
  for any options object without a `null` in it.

## 0.32.0

### Minor Changes

- [`a084c52`](https://github.com/octabits-io/platform/commit/a084c52a3760ef8dc4754b51e22d5295075de35f) - queue: `createBossManager` takes a `role` so send-only processes stop running pg-boss's background machinery
  
  `send()` needs a *started* boss — pg-boss owns its own pool and opens it in
  `start()` — so a process that only enqueues still has to start one. Until now
  that meant starting a *full* one: maintenance supervision, the queue monitor,
  the cron timekeeper, and a schema migration pass. That is the right shape for a
  long-lived consumer and the wrong one for a cron pod that enqueues three jobs
  and exits ten seconds later.
  
  `role: 'producer'` sets `supervise: false`, `schedule: false`, `migrate: false`
  and nothing else. `role: 'full'` (the default) is byte-for-byte the previous
  behavior, so existing consumers are unaffected.
  
  `migrate: false` is the load-bearing flag. With migration on, every start is a
  potential DDL run, and ephemeral producers race the long-lived processes over
  the same schema on every tick. With it off, pg-boss *checks* the installation
  instead and throws `pg-boss is not installed` or `pg-boss database requires
  migrations` — which is what a producer wants: it never migrates, and it fails
  loudly rather than proceeding against a schema it cannot use.
  
  The consequence to know about: a `'producer'` process cannot bootstrap a fresh
  database. Something with `role: 'full'` must have started at least once first —
  and when that ordering is wrong, `start()` now says so in those terms rather
  than reporting pg-boss's bare "pg-boss is not installed" (the original is kept
  as the error's `cause`).
  
  ```ts
  const bossManager = createBossManager({
    connectionString,
    logger,
    role: 'producer', // enqueues and exits; never consumes, never migrates
  });
  ```

- [`f341fee`](https://github.com/octabits-io/platform/commit/f341fee348918070ba9e9ed7d889ad125050cf76) - hono: warn when `getConnInfo` fails on Bun instead of silently disabling per-IP rate limiting
  
  `createClientIpMiddleware`'s default direct-IP seam caught every `getConnInfo`
  error and returned `undefined`, which the resolver renders as the literal
  string `'unknown'`. That is correct off-Bun (a Node test run has no conninfo),
  but on Bun it is a silent security downgrade: if the Bun server object never
  reaches `c.env`, *every* request resolves to `'unknown'` and each per-IP rate
  limiter keyed on `clientIp` collapses into ONE global bucket shared by all
  callers. The limiter keeps returning 429s, so it looks healthy while metering
  the entire internet together.
  
  The two cases are now distinguished. A failed `import('hono/bun')` means "not
  on Bun" and stays silent; an import that succeeds while `getConnInfo` throws
  means "on Bun and misconfigured" and warns once per process, naming the fix:
  
  ```ts
  Bun.serve({ fetch: (request, server) => app.fetch(request, { server }) })
  ```
  
  The key must be `server` — `hono/bun`'s `getBunServer` reads
  `'server' in c.env ? c.env.server : c.env`, so any other property name falls
  through to the env object itself, which has no `requestIP`.
  
  `createClientIpMiddleware` accepts an optional `logger` for the warning
  (defaults to `console.warn`). Behavior is otherwise unchanged and still fails
  safe — requests succeed, the IP is simply unknowable.

## 0.31.0

### Minor Changes

- [`c84a4ab`](https://github.com/octabits-io/platform/commit/c84a4ab5956cf5a75376dfc448b61508717a730b) - Expose `ensureQueue()` on `QueueDomain` and on `defineQueue().createEnqueuer()`.
  
  The step already existed and is already memoized — `enqueue` and `startWorker`
  call it on first use — but there was no way to run it *on its own*, which the
  ordinary producer never needs and one producer cannot do without.
  
  That producer enqueues through a connection it does not own: a job written
  inside someone else's open transaction, so the job and the state change that
  produced it commit together (pg-boss's `SendOptions.db`). Creating a queue is
  DDL and must never ride that transaction — a rollback would undo it, and its
  locks could outlive the send. Such a caller has to ensure the queue on the pool
  first and only then send, and until now its only options were to send once
  non-transactionally to trigger the ensure, or to re-implement
  create-DLQ-then-create-queue-pointing-at-it in its own code, where it would
  drift from the version here.
  
  It returns `Promise<Result<void, QueueError>>` like the rest of the interface —
  a failing ensure (dead pool, missing DDL permission) is a value, not a throw.
  Concurrent first calls now share a single run instead of each issuing the DDL,
  and a failed ensure is not cached, so the next call retries.

## 0.30.1

### Patch Changes

- [`7bfc47b`](https://github.com/octabits-io/platform/commit/7bfc47b92cb4873461fe2db5113a03cacf8e1150) - Widen the optional `octaflow` peer to `^0.16.0 || ^0.17.0`.
  
  `./hono/flow` only consumes the public-view half of octaflow — `toPublicWorkflow`
  / `toPublicStep`, the response schemas, and the structural `FlowEngineReader` it
  declares itself — none of which 0.17 touched. Its breaking changes are on the
  worker seam (`handleStepJob` replacing `executeStep`) and the `WorkflowStore`
  contract, neither of which the framework implements or calls.
  
  The narrow range was load-bearing for consumers, not cosmetic: octaflow is an
  *optional peer*, so a version outside the range forks the framework into a
  second peer variant — two physical copies, two nominal identities for `Result`,
  and a declaration emit that dies on TS2883.

## 0.30.0

### Minor Changes

- [`07a7342`](https://github.com/octabits-io/platform/commit/07a7342064de0bd2f784b5f6d3ba48df2f1dbd6a) - mail: expose `baseSubject` on rendered emails
  
  `render()` and `buildEmailContent()` now return `baseSubject` alongside
  `subject` — the template's own subject, before the `"<brand> - "` prefix and
  the `"[→ …] "` redirect prefix are applied.
  
  Consumers that persist a rendered subject as a durable **thread title** (rather
  than as an envelope header) should switch to `baseSubject`. Storing the branded
  `subject` and later re-sending under it brands an already-branded string,
  producing `"Brand - Brand - …"`, and leaks the dev-only redirect prefix into
  stored data.
  
  `RenderedEmail.baseSubject` is optional so snapshots persisted before this
  release deserialize unchanged; `dispatchRendered()` ignores it and continues to
  send `subject` verbatim.

## 0.29.0

### Minor Changes

- [`8346448`](https://github.com/octabits-io/platform/commit/8346448fa87a0755a2aa911bfde7bb5fc6104869) - feat(zitadel): add `addProjectRole` + `listProjectGrants`, and fix the always-stale diff in `syncProjectGrant`
  
  The Zitadel client could read a project's roles and propagate them to grants,
  but could not **create** a role and could not read a grant's current
  `roleKeys` — `getProjectGrantId` returns the id alone. That left role
  reconciliation impossible to build on the client: a consumer wanting to assert
  "every role in my registry exists on the project, and every tenant grant
  delegates all of them" had to hand-roll both calls against `fetch`.
  
  Two additions close that:
  
  - **`addProjectRole({ projectId, projectOwnerOrgId, roleKey, displayName?, group? })`** —
    creates a role on the project. Zitadel rejects a duplicate key with
    `already_exists`, which a reconciling caller should read as "present".
  - **`listProjectGrants({ projectId, projectOwnerOrgId })`** — every grant of a
    project with the role keys it currently delegates, as `ZitadelProjectGrant[]`
    (also newly exported).
  
  `syncProjectGrant` had a latent bug the second addition fixes. It read the
  existing grant's roles from the grant-search response as `roleKeys`, but that
  response names the field **`grantedRoleKeys`** — `roleKeys` is the *write*-side
  spelling. Every existing grant therefore compared as having zero roles, the
  "unchanged" check never held, and every sync issued a PUT. It only looked
  correct because Zitadel answers a no-op PUT with HTTP 400 `NoChangesFoundc`,
  which the method already swallowed. The diff is now accurate: an up-to-date
  grant is two reads and no write, and the `NoChangesFoundc` catch narrows to
  what it was meant for — a stale read losing a race with a concurrent sync.
  
  `getProjectGrantId` and `syncProjectGrant` both delegate their grant search to
  `listProjectGrants`, so the field-name knowledge lives in one place.

## 0.28.6

### Patch Changes

- [`f858de2`](https://github.com/octabits-io/platform/commit/f858de2c663a5e31cc1bd5ddbe0cd5382ca0c115) - Narrow the `octaflow` optional peer back to `^0.16.0`, reverting the `>=0.15.0 <1`
  widening from the previous release.
  
  The wide range let two octaflow minors be simultaneously in-range in one install.
  pnpm keys a package's physical copy on its resolved peer set, so a workspace where
  some packages reached 0.15 and others 0.16 got **two copies of this package** — two
  nominal `Result` types, and a TS2883 avalanche on the consumer's declaration emit,
  with no unmet-peer warning to point at the cause. A caret peer makes that drift
  loud at install time instead.
  
  The trade the widening bought — flow minors not needing a matching framework
  release — is not worth it here: `octaflow` and this package are released together,
  so a paired bump is the normal path, not a tax. Consumers should keep octaflow on
  one version tree-wide regardless (a `pnpm.overrides` pin is the blunt way);
  declaring the exact supported minor is how this package says so.

## 0.28.5

### Patch Changes

- [`637d926`](https://github.com/octabits-io/platform/commit/637d92600c3285be35f61e5736ebf6114aee5a9a) - Widen the `octaflow` optional peer range to `>=0.15.0 <1`.
  
  `./hono/flow` declared `octaflow: ^0.15.0`, and a caret on a pre-1.0 version locks
  the minor — so flow 0.16.0 fell out of range and consumers hit an unmet peer for a
  release that changes nothing this module touches. The route factory reads flow's
  public wire view (list/active/get/snapshot/cancel/resume); 0.16.0's breaking change
  is confined to `StartJobProcessor` implementations, which live app-side.
  
  The range now spans the whole pre-1.0 line, so flow's minors no longer need a
  matching framework release to stay installable.

## 0.28.4

### Patch Changes

- [`3c89fb9`](https://github.com/octabits-io/platform/commit/3c89fb97cc4851f45af1e78ce340bba2b621df9b) - Follow the workflow engine's rename: `@octabits-io/flow` is now `octaflow`.

  Imports and the peer range move together (`^0.12.0` → `^0.15.0`). The old
  package is deprecated on npm at 0.13.0 and would have kept the framework three
  minors behind — including a step-claim race and a stall where a lost dispatch
  stranded a workflow forever, both fixed since.

  No API change here: `createFlowWorkflowRoutes` and everything around it are
  untouched, and the engine's exports kept their names through the rename.

## 0.28.3

### Patch Changes

- [`ad63982`](https://github.com/octabits-io/platform/commit/ad63982bd83ab4436e27ce04cd60090bddd1893f) - fix(hono): log `HTTPException`s instead of passing them through silently

  `registerErrorHandler`'s `onError` returned `error.getResponse()` for any
  `HTTPException` before reaching the logger, so that branch — the one Hono's own
  middleware uses — produced no server-side trace at all. Every other error path
  was logged, which made the gap easy to miss: an API could serve a steady stream
  of 400s while its logs showed nothing but pod lifecycle lines.

  The errors this hid are the ones with no other trace either. Hono raises
  `HTTPException` for a malformed JSON body, an unparseable `FormData` body and a
  failed bearer check, and answers with a bare `text/plain` body — which a client
  expecting the framework's JSON error envelope cannot read. Such a failure was
  observable from neither side. (Found in a consumer: a bodyless request that carried a
  JSON content-type turned into `400 Malformed JSON in request body`, and the
  console could only report a generic "Bad Request".)

  `HTTPException`s are now logged before their response is returned: 5xx at error
  level with the error itself, 4xx at warn, both carrying
  `http.request.method`, `url.path` and `http.response.status_code`. The response
  is unchanged. Only >= 400 is logged, since `HTTPException(status, { res })` is
  also the supported way to answer with an exact `Response` from deep inside a
  handler and a successful one of those is not an error event.

## 0.28.2

### Patch Changes

- [`2e32140`](https://github.com/octabits-io/platform/commit/2e321400db14ad6952fb91a14939554459fe117a) - fix(drizzle): stop typing `.schema` onto a transaction

  The nested-transaction fix made the runtime right and left the types behind.
  `augmentDrizzle` no longer overwrites `PgTransaction.schema`, so on a
  transaction that field is Drizzle's `RelationalSchemaConfig` — but
  `AppTransaction` and `DbOrTransaction` were plain aliases of `AppDatabase`,
  which declares `schema: TSchema`. `tx.schema.someTable` therefore compiled and
  handed back `undefined`, with nothing but a doc comment against it. (Drizzle
  declares `PgTransaction.schema` `protected`, so the public claim came entirely
  from the alias.)

  `.schema` is now declared only on `AppDatabase`, the connection — the only place
  the factory sets it. `AppTransaction` is the shared shape without it, and
  `DbOrTransaction` aliases the transaction rather than the connection, so it
  promises only what both actually have. An `AppDatabase` is still assignable
  wherever a transaction or either is accepted, so `tx?: DbOrTransaction`
  parameters keep taking a `db`; the reverse no longer type-checks, which is the
  point.

  `.tables` is unchanged and remains the accessor for tables on both. Code that
  read `.schema` off a value typed as a transaction or `DbOrTransaction` now fails
  to compile — that read was already returning the wrong object at runtime.

## 0.28.1

### Patch Changes

- [`ded3551`](https://github.com/octabits-io/platform/commit/ded3551b4166a3e0027b5997436bf090bcdac79c) - fix(drizzle): keep the relational query API on nested transactions

  `augmentDrizzle` assigned its `.schema` alias unconditionally, overwriting the
  `schema` field Drizzle's `PgTransaction` owns — its `RelationalSchemaConfig`.
  `PgTransaction.transaction()` feeds exactly that field to the savepoint
  transaction's constructor, so a nested transaction was built with no relational
  config and came back with an empty `.query` API: `tx.query.foo` was `undefined`
  one level down, while `.select()` / `.insert()` kept working. Top-level
  transactions were unaffected (the driver's session builds those from its own
  schema reference), which is why this only ever surfaced on the second level.

  The alias is now only set when Drizzle does not already own that field. On a
  transaction, `.schema` is therefore Drizzle's config rather than the schema
  module; `.tables` is unchanged and remains the accessor to use for tables. The
  RLS wrapper now reads the schema module from `.tables` for the same reason.

## 0.28.0

### Minor Changes

- [`20ddd6d`](https://github.com/octabits-io/platform/commit/20ddd6da7f60e4e3c75116e59520ac3afb6e2f1f) - **`./utils`: add `getReadableTextColor` and `getContrastRatio`.** A single brand
  color has to serve two roles that pull in opposite directions — a fill wants the
  saturated color, text on the page background wants contrast — and one value
  cannot satisfy both. A sage `#99A89E` is perfectly good on a button and measures
  2.48:1 as 14px text on white, well under the 4.5:1 floor. `getContrastColor`
  already answers "what goes ON this color"; nothing answered "what does this
  color become when it IS the text".

  `getReadableTextColor(hex, background?, minRatio?)` returns the least-adjusted
  version of a color that clears the ratio: hue preserved, stepped toward black on
  a light background or toward white on a dark one, and returned unchanged when it
  already passes — so well-chosen brand colors are never touched. `#99A89E` on
  white becomes `#6e7972` at 4.52:1. Consumers are expected to keep the raw brand
  color for fills and route only the text role through this, rather than replacing
  the color globally.

  Stepping happens in sRGB, not OKLCH, because the WCAG ratio being satisfied is
  itself defined over linearized sRGB — walking that space lands on the threshold
  exactly instead of overshooting through a perceptual round-trip.

  `getContrastRatio(foreground, background)` exposes the underlying WCAG 2.x ratio
  (1–21) so callers can decide for themselves, e.g. to warn an operator that their
  chosen color will be substituted. It returns `1` rather than `NaN` for
  unparseable input, so "cannot parse" reads as "fails" without a special case.
  `WCAG_AA_NORMAL_TEXT` (4.5) and `WCAG_AA_LARGE_TEXT` (3) are exported alongside.

  `getContrastColor` is unchanged in behavior. Internally it now shares the
  parsing and luminance helpers, and it deliberately keeps its lenient handling of
  malformed input — it has always degraded to the dark result rather than
  throwing, and a regression test pins that. The new functions use a strict parser
  that reports failure instead.

## 0.27.0

### Minor Changes

- [`539ea6d`](https://github.com/octabits-io/platform/commit/539ea6d7af95da39d49884fab26915e8413d359f) - **`./logger`: export OTLP as protobuf, not JSON.** The exporter POSTed
  OTLP/JSON, which the spec makes optional — and real backends decline it.
  VictoriaLogs answers such a request with `400 … json encoding isn't supported
for opentelemetry format`, so every exported record was silently dropped
  against it. Records now go out as `application/x-protobuf`, the encoding the
  spec requires every receiver to accept.

  The encoder (`./otlp-protobuf`) is hand-written — varint, fixed64, and
  length-delimited fields are all OTLP logs uses — because `./logger` is a base
  module that every other module imports and must not pull in an SDK. It consumes
  the same payload tree `encodeLogsPayload` already built for JSON, so grouping,
  attribute mapping, and timestamps keep exactly one implementation.

  `encoding: 'json'` restores the previous wire format for a collector known to
  accept it, and `LOGGING_CONFIG_SCHEMA` parses it alongside `endpoint` and
  `headers` so the switch is reachable from env config. Nothing else changes:
  same config, same batching, same best-effort delivery.

  Two related fixes to attribute encoding: integers beyond `Number.MAX_SAFE_INTEGER`
  now go out as `doubleValue` instead of an `intValue` that overflows int64 — or,
  from `1e21`, one the encoder could not parse at all, which cost the entire batch
  rather than the one attribute. And `content-type` is no longer overridable
  through `headers`, so a leftover `application/json` cannot mislabel a protobuf
  body.

  Records also now carry `observedTimeUnixNano`, which the log data model says
  MUST be set and which the exporter previously omitted in both encodings. It
  holds the same instant as `timeUnixNano`, since these records are exported from
  where they are generated.

  Worth knowing if you relied on the old default: a receiver that only parsed
  JSON will now reject these requests, and `onError` will say so.

## 0.26.0

### Minor Changes

- [`592b32b`](https://github.com/octabits-io/platform/commit/592b32b33ce12e7271dbf060d435f4115c0b40ae) - Security hardening across `./events`, `./storage/postgres`, `./pii`, and
  `./drizzle/event-outbox`.

  **`./events` — SSE replay ignored `audience.users` (cross-user leak).** The
  live fan-out path applied both delivery filters, but the `Last-Event-ID` replay
  path ran only the permission half, so a durable event addressed to specific
  users was delivered to every subscriber in the scope that reconnected. Since
  `lastEventId` is client-supplied (header or query param) and replay reaches
  back `lastEventId − replayLookback`, this was requestable on demand. Both paths
  now share one exported predicate, `isEnvelopePermitted` — use it if you build
  your own replay or catch-up source.

  **`./storage/postgres` — `Cache-Control` default is now `private, no-store`.**
  The serve handlers hardcoded `public, max-age=31536000, immutable` with no
  override, marking access-controlled blobs publicly cacheable — a shared CDN or
  reverse proxy could store one caller's object and re-serve it to another. The
  new `ServeHandlerOptions.cacheControl` restores the old value where it is
  actually correct (content-addressed public assets); `DEFAULT_CACHE_CONTROL` is
  exported.

  **`./storage/postgres` — 5xx responses no longer echo the storage error.** The
  handlers wrote the underlying failure (potentially driver/SQL internals)
  straight into the response body; they now emit a fixed `Internal error`,
  matching `./server`'s production redaction. 4xx bodies are unchanged.

  **`./pii` — the decrypted-key cache TTL is now enforced by the service.**
  `createScopedKeyService` stamps and checks its own expiry on every read instead
  of trusting the injected cache's eviction policy — the seam is structural, so a
  consumer could satisfy it with a plain `Map` and pin plaintext age identities
  in memory for the process's lifetime. New `cacheTtlMs` (default
  `DEFAULT_KEY_CACHE_TTL_MS`, 5 min) and `dateProvider` deps. `ScopedKeyCache`
  loses `has`, which existed only to answer a question the TTL check now owns.

  **`./pii` — `destroyKeys()` can invalidate other processes.** Crypto-shredding
  only ever dropped the calling process's cache; every other pod kept serving its
  copy until its TTL lapsed. The new `onKeysDestroyed(scope)` seam broadcasts the
  destruction (wire it to `./events`, `pg_notify`, or your bus; receivers call
  `invalidateCache()`). A failing broadcast is logged via the new optional
  `logger` dep and does not fail the destroy.

  **`./drizzle/event-outbox` — a scope-less store now refuses multi-scope use.**
  Omitting `scope` leaves no column to filter on, so `readSince` returned the
  whole outbox and relabelled every envelope with the caller's `scopeKey` — a
  cross-scope replay leak for anyone who omitted `scope` outside a genuinely
  single-scope deployment. The store now throws on the second distinct
  `scopeKey` it sees (append, notify, or read) instead of silently mixing them.

  ⚠️ Consumers serving genuinely public assets from `./storage/postgres` must
  pass `cacheControl: 'public, max-age=31536000, immutable'` to keep CDN caching.

  ⚠️ A custom `ScopedKeyCache` implementation may drop its now-unused `has`.
  Long-lived processes that relied on an unbounded key cache will re-read and
  re-decrypt keys every `cacheTtlMs`; raise it if that matters more than the
  in-memory exposure window.

### Patch Changes

- [`5552702`](https://github.com/octabits-io/platform/commit/555270268e7815fc48cc00ec05d40f55896adc36) - **Docs: document `createOtlpLogExporter`.** The 0.25.0 OTLP release exported the
  exporter factory but `docs/foundation.md` only covered the `LoggingConfig.otlp`
  path, so the standalone use — feeding records that don't come from this
  package's `Logger`, or aiming a second exporter at a different collector — was
  discoverable only from the changelog. The `./logger` section now shows
  `createOtlpLogExporter` with `enqueue`/`forceFlush`/`shutdown`, and notes the
  `fetchImpl` test seam.

## 0.25.0

### Minor Changes

- [`ffd914a`](https://github.com/octabits-io/platform/commit/ffd914acf555b820e7a5d58628331310a590afb5) - **`./logger`: implement OTLP log export.** `LoggingConfig.otlp` has always been typed and validated (`LOGGING_CONFIG_SCHEMA.otlp`) with the promise that "logs will be sent to an OTLP collector" — but `createLoggerService` never read the field, so consumers forwarding it got nothing. It now works.

  When `otlp` is set, records are batched and POSTed to the collector as OTLP/HTTP **JSON** via plain `fetch` — no OpenTelemetry SDK, so `./logger` stays dependency-free for the consumers that only log to stdout. No consumer change is needed: the existing `endpoint`/`headers` config starts taking effect on upgrade.

  Delivery is best-effort by design — logging must not be able to fail a request. Export runs off the hot path, a full buffer drops its oldest records, and failures are reported through `onError` (default `console.error`) rather than thrown. Nothing is retried.

  - New: `createOtlpLogExporter` and the `OtlpLogExporter` / `OtlpExporterConfig` / `LogRecord` types are exported from `@octabits-io/framework/logger`.
  - `OtlpExporterConfig` adds optional `maxBatchSize` (512), `maxQueueSize` (2048), `scheduledDelayMs` (5000), `timeoutMs` (10000), `onError`, and a `fetchImpl` test seam alongside `endpoint`/`headers`.
  - `LoggerService.shutdown()` is no longer a no-op: it drains the export buffer and awaits in-flight requests. **Consumers configuring `otlp` should `await loggerService.shutdown()` on exit**, or buffered records are lost. It remains a no-op without `otlp`.

  Two behaviour changes fall out of unifying the development and production loggers so both feed the exporter:

  - `consoleOutput: false` is now honoured in `environment: 'development'` too (previously it silenced production JSON output only, and dev logs printed regardless).
  - Development output now prints an error's stack on its own line below the message. It was previously dropped entirely from the human-readable renderer; it has always been present in the JSON/exported record.

## 0.24.1

### Patch Changes

- [`cf47a81`](https://github.com/octabits-io/platform/commit/cf47a811c3b39e398c533abab30349ce292fc942) - Bump the `@noble/ciphers` and `@scure/base` hard dependencies to `^2.3.0`, aligning them with `@noble/curves`/`@noble/hashes`.

  Both releases carry changes that do not affect this package's usage:

  - `@scure/base` 2.3.0 removes its internal `utils`/`bytesToString`/`stringToBytes` exports and the `SomeCoders` type. `./pii` imports only the coders (`base64`, `base64nopad`, `bech32`), which are unaffected. The release also brings a large encode/decode speed-up.
  - `@noble/ciphers` 2.3.0 now throws when AAD is passed to a cipher that does not support it. `./pii` uses `chacha20poly1305` (which supports AAD) and passes none.

- [`9e504a3`](https://github.com/octabits-io/platform/commit/9e504a376f3db75a6d73832096cf388e7ada0103) - Widen the `@hono/standard-validator` peer range to `^0.3.0 || ^0.4.0`.

  The range was left at `^0.3.0` when the devDependency moved to `^0.4.0`, so
  the declared peer excluded the only version this package is actually built and
  tested against (and the current `latest`). A consumer following the peer range
  would install 0.3.x.

  The peer itself is load-bearing despite nothing in `src/` importing it:
  `hono-openapi` statically imports `sValidator` from `@hono/standard-validator`
  at the top of its entry module, so anything that pulls in
  `@octabits-io/framework/hono/openapi` needs it resolvable at runtime. It stays
  optional, since only that subpath requires it.

## 0.24.0

### Minor Changes

- [`fd082df`](https://github.com/octabits-io/platform/commit/fd082df4c8d40cb8cd98c9a64e3ad81b000ce716) - Make Mailjet sends observable after hand-off.

  The Mailjet transport returned `messageId: null` and discarded the rest of the
  Send v3.1 response, so a Mailjet-backed send had no handle at all tying it to the
  provider's later delivery events — a bounce was indistinguishable from a
  delivery, forever.

  - `SentMailInfo` gains `providerMessageId`: an opaque, provider-scoped handle for
    correlating delivery events, kept deliberately separate from `messageId` (the
    RFC 5322 header id, which is the only thing that can thread an inbound reply).
    SMTP and Brevo set both to the same value; Mailjet now returns its
    `MessageUUID` as `providerMessageId` and still `null` as `messageId`. The field
    is optional, so existing `MailTransport` implementations keep compiling —
    consumers should read `providerMessageId ?? messageId`.
  - New `parseMailjetEvents` / `mapMailjetEventToDeliveryStatus` exported from
    `@octabits-io/framework/mail/mailjet`, mirroring the Brevo event parser and
    emitting the same `NormalizedDeliveryEvent`. Events correlate on
    `Message_GUID` (the value the Send API returned as `MessageUUID`). Mailjet's
    `sent` maps to `delivered` — it has no separate delivered event, and `sent`
    means the recipient's mail server accepted the message; `bounce` splits to
    `bounced`/`failed` on the `hard_bounce` flag; `blocked` and `spam` map to
    `bounced`.

## 0.23.0

### Minor Changes

- [`55ef671`](https://github.com/octabits-io/platform/commit/55ef67140a2ceb486fb42be45a6b215320d1846c) - **Breaking:** remove the Elysia glue module. The `./elysia`, `./elysia/mcp`, `./elysia/flow`, `./elysia/events` and `./elysia/testing` subpaths are gone, along with the `elysia`, `elysia-mcp`, `elysia-rate-limit` and `@sinclair/typebox` dependencies — `@noble/*`/`@scure/base` are now the package's only hard deps. `./hono` reached parity and is the sole HTTP glue module.

  Migrating: `createElysiaApp` → `createHonoApp`, `createRequestScopePlugin` → `createRequestScopeMiddleware`, `createBearerAuthPlugin` → `createBearerAuthMiddleware`, `createErrorHandler` → `registerErrorHandler`, `body`/`query`/`params` route options → `octValidator`/`octApiValidator`, and `./elysia/{mcp,flow,events}` → `./hono/{mcp,flow,events}`. `./elysia/testing` was already just a re-export of `./server/testing`. Full table in the package README.

  The boundary lint now rejects Elysia's vendors package-wide, so the glue cannot creep back in.

  The framework-neutral cores in `./server` are unchanged — that is what made the swap shallow. Their unit tests, which had only ever lived in the Elysia suite, moved to `src/server/*.test.ts` alongside the code they cover: error mapping (`getStatusCodeForError`, `statusErrorWithSet`, `mapResultError`, `createErrorMapper`, `isDbConnectionError`, `resolveErrorResponse`), the response-schema helpers, `buildSecurityHeaders`, the client-IP trust walk (`normalizeIp`, `createClientIpResolver`, incl. CIDR trusted proxies), `createCidrMatcher`, and the env-config helpers.

## 0.22.0

### Minor Changes

- [`26a8058`](https://github.com/octabits-io/platform/commit/26a80582ebf53ebbe7d936b5c363eb62f3f86860) - Add a `discarded` delivery status for mail a review gate rejected

  `MAIL_DELIVERY_STATUSES` covered how a send _failed_ but not the case where it
  never happened: a confirmation gate holds a mail for review and a human decides
  not to send it. Consumers had to reuse `failed`, which reads as a delivery error
  that never occurred — misleading in an audit trail an operator reads.

  `discarded` is appended to the tuple (no reordering, so any consumer deriving a
  storage enum from it keeps its existing values). No provider emits it; it is set
  by the gate that owns the hold.

## 0.21.1

### Patch Changes

- [`818ce91`](https://github.com/octabits-io/platform/commit/818ce9106b984a6b208e47fe1164ff43050a129c) - Bump the `@noble/curves` and `@noble/hashes` hard dependencies to `^2.3.0`.
  `@noble/curves` 2.3.0 hardens X25519 against a remote timing attack that leaked
  up to 4 bits of a long-term private key across many samples — fingerprinting
  grade, not key recovery — and lands the Trail of Bits review fixes plus
  across-the-board constant-time hardening. `./pii`'s hybrid (age) encryption is
  the consumer of that curve, so the bump is worth taking deliberately.
  `@noble/hashes` 2.3.0 is perf and stricter type checks, with an HMAC
  `_cloneInto` `canXOF` fix. No API change on either side of the framework
  surface.

## 0.21.0

### Minor Changes

- [`58c886b`](https://github.com/octabits-io/platform/commit/58c886b07d2eb99fafe62f014401c4ed03043f9b) - zitadel: `inviteUserToOrg` accepts an optional `preferredLanguage`

  Zitadel picks the language of the invitation mail from the user it creates.
  Without a preference it falls back to the instance default, so an invite sent
  on behalf of a German tenant arrived in English regardless of that tenant's
  configured language.

  The tag is applied only when the user does not already exist — an existing
  user has their own preference and it must not be overwritten by whoever
  happens to invite them next.

## 0.20.0

### Minor Changes

- [`fbb559f`](https://github.com/octabits-io/platform/commit/fbb559f8fc568cc706fa171d6818671a2dc7fcb7) - storage: per-object `visibility` option on `uploadObject`

  `uploadObject` accepts an optional `visibility: 'public' | 'private'` that
  overrides the provider's configured default ACL for that one object. The S3
  provider maps `'private'` → ACL `private` and `'public'` → `public-read`;
  omitted keeps the existing `defaultACL` behavior. Providers without
  object-level access control (Postgres) ignore it.

  Motivation: object ACLs grant access independently of any bucket policy, so
  sensitive objects (e.g. encrypted mail attachments) uploaded under a
  `public-read` default stayed world-readable even when the bucket policy
  excluded their prefix.

## 0.19.1

### Patch Changes

- [`c8c077b`](https://github.com/octabits-io/platform/commit/c8c077b13a0e35671294bb625cef7be47aa4e1b9) - Dedupe `createRequestScopeMiddleware` (Hono) across overlapping route mounts: when several modules sharing a mount prefix each carry the scope middleware, Hono copies every module's `use('*')` entry into the parent router, so one request could allocate a scope per overlapping module — each holding a pooled (RLS) DB connection for the rest of the request. The middleware now passes through when its context key is already populated: the first instance owns the scope, nested runs are no-ops. Middlewares with distinct `contextKey`s still stack.

## 0.19.0

### Minor Changes

- [`f56675c`](https://github.com/octabits-io/platform/commit/f56675c717a180760c94d1b10a468a3c87e5b8cc) - Two `./hono` gaps surfaced by the first consumer wave:

  - `createHonoApp` accepts a `hono` option (Hono constructor options for the
    composed serving app). Passing `{ strict: false }` restores Elysia's
    trailing-slash tolerance (`/x` ≡ `/x/`) for consumers migrating
    route-for-route — normalization happens on the outer app, so this could not
    be opted into from the routes side.
  - `describeApiRoute` passes OpenAPI specification extensions (`x-…` keys, e.g.
    `'x-openai-isConsequential'`) through to the operation object.

## 0.18.0

### Minor Changes

- [`46c6714`](https://github.com/octabits-io/platform/commit/46c67143b23e20e7b7ceefafd490f2600bfe0a01) - Remove the deprecated `runElysiaServer` / `RunElysiaServerOptions` aliases from `./server` (and the `./elysia` re-export). They were renamed to `runServer` / `RunServerOptions` in 0.17.0 — same function, nothing about it is Elysia-specific. Migration: rename the import; the `./elysia` compat re-export of the rest of the server toolkit is unchanged.

- [`64c835c`](https://github.com/octabits-io/platform/commit/64c835c12a3b0b2e159ea2b81e94d2e06d43e95b) - New `./hono` glue module — the successor of `./elysia`.

  - **`./hono`**: `createRequestScopeMiddleware` (the disposal triangle as one wrapping middleware), `createBearerAuthMiddleware` (Response short-circuit), `registerErrorHandler` + `octValidator` (shared `resolveErrorResponse` core; raw thrown `Response` becomes `HTTPException(status, { res })`), `createSecurityHeadersMiddleware`, `createClientIpMiddleware` (lazy Bun conninfo, off-Bun safe), `createRateLimitMiddleware` (vendor-free fixed-window on in-house cores), `createHealthApp`, `createHonoApp`, `createRouteModule` (closes the declared-`Env` hole by construction), `testableHonoApp`.
  - **`./hono/flow`**: `createFlowWorkflowRoutes` without the prefix generic or the Elysia type workarounds — mount via `app.route(prefix, …)`.
  - **`./hono/mcp`**: the MCP harness on official `@hono/mcp` (per-request `McpServer` + `StreamableHTTPTransport`; replaces the nested-app workaround). Same `parseScopeKey`/`DisposableScope` seams.
  - **`./hono/openapi`**: `describeApiRoute` (takes the existing `successResponses`/`errorResponses` zod maps), `octApiValidator` (validation + spec + standard `validation_error` body), `mountOpenApi` over `buildSwaggerOptions` — on `hono-openapi` (middleware-style, `hc`-safe), vendor-confined to one file with a composition gate test.
  - **`./hono/events`**: `createEventStreamApp` sub-app wrapper over the SSE handler.

  The framework-neutral cores moved to the base tier (`./server`): error mapping/`ApiError` family/`resolveErrorResponse`, request-scope + bearer-auth structural contracts, `buildSecurityHeaders`, the client-IP trust-walk resolver, and the rate-limit cores incl. a new `createFixedWindowLimiter`. Everything remains re-exported from `./elysia` — no breaking changes; `./elysia` is now maintenance-only (see `docs/elysia.md`).

  `hono`, `@hono/zod-validator`, `@hono/mcp`, and the `hono-openapi` stack are optional peer dependencies — installing them activates the `./hono/*` subpaths. The boundary lint now enforces the same per-file vendor confinement for `src/hono` as for `src/elysia`.

  **`hc` client-type preservation (found by migrating `apps/demo-*` onto the module).** Four separate places silently dropped or broke the route types a typed client is built from — every one of them invisible at runtime, since the app keeps serving either way:

  - `createHonoApp`, `createHealthApp`, `mountOpenApi`, `registerErrorHandler` and `createEventStreamApp` annotated their returns as `Hono` (= `BlankSchema`), erasing every route from `hc<typeof app>`. They now carry the app type through — as ONE type parameter (`T extends Hono<any, any, any>`), because decomposing into `<E, S, P>` loses nested `.route(...)` schemas just as thoroughly.
  - `mountOpenApi` additionally must not return its own `app.get(specPath, …)` type: `specPath` is a `string`, and Hono collapses a schema keyed by a non-literal path into an index signature, taking every sibling route with it.
  - `./hono/flow` typed its served workflow view as `z.output<typeof buildFlowWorkflowSchema(ext?.schema)>`, which carries an unevaluated `$InferObjectOutput<…>` conditional into every route's output. TypeScript 7 absorbs it; **TypeScript 6 overflows its call stack** on `hc<App>` — a hard failure for consumers pinned below 7 (e.g. anything on `vue-tsc`). It is now the equivalent intersection, and the emitted `flow.d.ts` shrank 62%.

  `create-app.test.ts` and `flow.test.ts` pin all of it.

## 0.17.0

### Minor Changes

- [`020309b`](https://github.com/octabits-io/platform/commit/020309b3cfe4a1fd295306324868f3b1b9de0e9f) - drizzle/rls: fail-closed drift guard on the scoped-db proxy. Unclassified Drizzle members now throw on use instead of silently running without the scope's GUCs (where RLS policies would match zero rows) — functions throw on invocation, object-valued namespaces on access; absent properties still read as `undefined`. New exports `QUERY_NAMESPACE_METHODS` and `SCOPED_DB_PASSTHROUGH_PROPS` carry the classification, and a contract test enumerates the installed drizzle-orm's db surface so any added/renamed/removed entry point fails the unit suite at upgrade time instead of drifting silently.

- [`ed52834`](https://github.com/octabits-io/platform/commit/ed52834b8029b783968d246d7ca3018e0a411c41) - New framework-agnostic `./server` module (+ `./server/testing`): the env-config helpers, `runServer`/`registerGracefulShutdown` (the `main()` tail; `runElysiaServer` stays as a deprecated alias), `buildSwaggerOptions`, the zod response schemas, and the request-test harness moved out of `./elysia` — none of them ever imported Elysia. `./elysia` and `./elysia/testing` re-export everything for full backwards compatibility.

  Elysia-confinement hardening in `./elysia`: `buildSecurityHeaders` (pure options→header-map core of the security-headers plugin) and `resolveErrorResponse` (the framework-neutral error classifier behind `createErrorHandler`) are now exported; the boundary lint enforces per-file rules (`elysia-mcp` only in `mcp.ts`, `elysia-rate-limit` only in `rate-limit.ts`, and every `src/elysia` source file must actually import an elysia-tier vendor). New `docs/server.md`; `docs/elysia.md` now documents the confinement contract / porting story.

## 0.16.0

### Minor Changes

- [`f185fc5`](https://github.com/octabits-io/platform/commit/f185fc5bb1096ea2bb44d113e6f2e6d752b3c224) - drizzle/rls: `createPinnedGucScopeFactory` — the per-request pinned-transaction scope model (§19 model B). One drizzle-managed transaction per scope: BEGIN + one set_config statement at scope creation, COMMIT/ROLLBACK at `dispose({commit})`, with the transaction-bound db registered as the scope's `db`. Nested `db.transaction()` gets real savepoints; concurrent queries serialize on the scope's one connection; the pool client is held for the scope's lifetime. The async factory plugs into `createRequestScopePlugin`'s promise-accepting `createScope`. `ScopeChild` gains `onDispose` (the ioc scope always had it).

## 0.15.0

### Minor Changes

- [`dc72bdf`](https://github.com/octabits-io/platform/commit/dc72bdf000d9adcff0809969fd7464ae9ec085c1) - elysia client-ip: trusted proxies now accept CIDR ranges (`10.0.0.0/8`, `2001:db8::/32`) alongside exact IPs and `'*'`. Enables replacing `trustedProxies: ['*']` with the actual proxy networks in environments where proxy addresses are ephemeral (Kubernetes ingress/sidecar pods), closing the spoofed-XFF rate-limit bypass. IPv4/IPv6 with embedded-v4 and v6-mapped forms handled; invalid entries are still silently dropped (a typo narrows trust, never widens it).

## 0.14.0

### Minor Changes

- [`a4a64db`](https://github.com/octabits-io/platform/commit/a4a64db8eac3ef09d99b4ea024b8e9dd94efb364) - Broadcast publish API reshape + shared `DbOrTx` seam:

  - `drizzle/broadcast`: the modal `publish(db, payload, tx?)` is split into
    two methods with nominal contracts — `publish(db, payload)` (best-effort:
    database failures logged, never thrown) and `publishInTx(tx, payload)`
    (delivered at COMMIT, dropped on ROLLBACK, database failures throw).
    Previously the error contract silently switched on whether the optional
    `tx` slot was used. **Breaking**: the three-argument `publish` form and
    the `BroadcastDatabase` type are gone (no released consumers).
  - `drizzle/db` gains `DbOrTx` — the shared minimal structural seam
    ("anything that can `execute` one SQL statement"; satisfied by a Drizzle
    db instance and by transaction contexts). `drizzle/broadcast` uses it
    directly; `EventOutboxDatabase` and `BackfillDatabase` now extend it
    instead of re-declaring `execute`.

- [`a4a64db`](https://github.com/octabits-io/platform/commit/a4a64db8eac3ef09d99b4ea024b8e9dd94efb364) - drizzle/db: shared `Db*` capability atoms (`DbSelectSource`, `DbInsertTarget`, `DbUpdateTarget`, `DbDeleteTarget`, `DbRelationalQuery`, `DbTransactionRunner`) alongside `DbOrTx` — every drizzle module's `*Database` seam is now a composition of these instead of a hand-rolled shape. The deep-chain seams (`EventOutboxDatabase`, `ScopedKeyStoreDatabase`, `JobAuditStoreDatabase`) flatten onto the atoms (strictly wider — anything that satisfied them before still does); their adapters now typecheck builder chains against drizzle-orm's real declarations via an internal typed view that never appears in a public signature. `RlsDatabase.execute` narrows to the shared `DbOrTx` signature (`(query: unknown) => Promise<unknown>`).

## 0.13.0

### Minor Changes

- [`5b5bd89`](https://github.com/octabits-io/platform/commit/5b5bd8911cbc193021ca4495e07ce4319e5f92b8) - Cache-invalidation primitives:

  - `LruCache.deletePrefix(prefix)` (utils): delete every string-keyed entry
    under a prefix, enabling namespace invalidation (e.g. everything for one
    tenant) without enumerating a key list that can drift from what was stored.
  - `createScopedConfigCache.invalidate` now deletes by scope prefix instead of
    looping the cacheable-key set — entries for keys that have since left the
    cacheable set can no longer be stranded. The `ConfigLruCache` structural
    seam gains a required `deletePrefix` member.
  - New `drizzle/broadcast` subpath: `createBroadcastChannel` — a minimal
    fire-and-forget broadcast over Postgres NOTIFY for cross-process
    coordination hints (cache invalidation and similar). Zod-validated payloads,
    at-most-once delivery with an `onReconnect` flush hook, publish-at-COMMIT
    when handed a transaction, and the same direct-URL LISTEN constraints as
    the events relay. Deliberately outside the events taxonomy: no envelope,
    outbox, audience, or SSE delivery.

## 0.12.0

### Minor Changes

- [`3dbadbf`](https://github.com/octabits-io/platform/commit/3dbadbf3e6c8e188f3f9efdeb3b0b1a30380951b) - Scoped config engine: null-resolved keys (no stored row and a null schema
  default) are now memoized as absent resolutions in both the request memo and
  the cross-scope cache, instead of re-querying the DB on every read batch that
  contains them. Consumer-visible semantics are unchanged — such keys are still
  omitted from results. `ScopedConfigCache.get/set` signatures widen to carry
  `null` as the absence marker (`undefined` remains the miss signal).

## 0.11.0

### Minor Changes

- [`0623bf6`](https://github.com/octabits-io/platform/commit/0623bf69090ba302e2bda24da638dd840df17263) - RLS wire-amplification cut: `createScopedDb`'s single-statement operations
  (builder chains, `query.*.find*`, `execute`) now take a pinned-client fast
  path that sends `BEGIN; SELECT set_config(...)` as one simple-query packet —
  3 round-trips per call instead of 4. `scopedDb.transaction()` /
  `runWithGucs` / `withSystemMode` keep the Drizzle-managed transaction
  (savepoint-correct for nested callbacks) but now apply all GUCs in a single
  merged `set_config` statement, and `acquireScopedClient` likewise combines
  BEGIN plus all session vars into one packet. New export: `escapeGucLiteral`
  (pg-compatible literal escaping used by the combined packets).

## 0.10.0

### Minor Changes

- [`4b6d5ec`](https://github.com/octabits-io/platform/commit/4b6d5ecdaac4b4fa5bd39e3ec719b44719b1ebf0) - events: make `EventPublisher`/`createEventPublisher` generic over a consumer `EventDataMap` (event type → payload shape), so `emit` correlates `type` with its `data` at compile time, and add an optional `payloadSchemas` registry to `createEventPublisherDeps` that enforces the same contract at runtime (authoritative: unregistered types throw, invalid payloads throw, validation never strips). Unparameterized publishers behave exactly as before.

## 0.9.0

### Minor Changes

- [`dfa40ee`](https://github.com/octabits-io/platform/commit/dfa40eef8bac6be5929508b4650bbd877b0be70e) - `createRateLimit`: new `skipPaths` option — path prefixes exempt from the limiter. For self-limiting endpoints that live outside the plugin hook chain, e.g. a `.mount()`ed SSE stream whose requests never see the client-IP plugin and would otherwise all share one "unknown" bucket.

## 0.8.0

### Minor Changes

- [`91c12a9`](https://github.com/octabits-io/platform/commit/91c12a968a5f0e684c3f0bdfa9659e75556a4082) - Add the events stack: cross-process, two-lane event fan-out with SSE delivery.

  framework:

  - `./events` — `EventEnvelope` (+ Zod schema), the notify wire codec, `createEventHub` (in-process per-scope fan-out with audience/permission filtering, fail-closed), `createEventPublisher` (`emit(event, tx?)`; durable events append to the outbox in the caller's transaction — throws so a failed append rolls the state change back), `createEventRelay` (notification → outbox → hub with per-scope watermark and bigserial-gap recovery), and `createEventStreamHandler` — the SSE endpoint as a **plain fetch handler** (heartbeats, capped connection age, `Last-Event-ID` replay with lookback, per-subscriber connection caps, `x-accel-buffering: no`), registrable via `.mount()` with zero Elysia type budget.
  - `./events/postgres` — `createPgNotifyListener`: one dedicated LISTEN connection per process (`pg` optional peer), full-jitter reconnect, `onReconnect` catch-up hook.
  - `./drizzle/event-outbox` — `eventOutboxColumns` (spreadable, no `pgTable`; bigserial `id` is the envelope `seq`) + `createDrizzleEventOutboxStore`: outbox INSERT + `pg_notify` pointer in the same transaction (durable), inline notify with an 8000-byte guard (ephemeral), `readSince`, `prune`.
  - `./elysia/events` — `createEventStreamRoute`, the thin `.use()`-style wrapper (literal-generic prefix) over the fetch handler.

  nuxt-ui-kit:

  - `./events` — `createEventStreamClient`: fetch-based SSE reader (header auth, so `Last-Event-ID`/reconnect are implemented here), full-jitter backoff with a `degraded` state past a threshold, durable-only watermark, bounded seen-id dedupe; `createSseFrameParser`; `useEventStream` Vue composable with reactive connection state.

## 0.7.1

### Patch Changes

- [`eb82de9`](https://github.com/octabits-io/platform/commit/eb82de9f01cd7bcfcdb187dbbd8fedd3e88e6849) - elysia errors: map `*_invalid_status` keys to 409 (they previously fell through the generic conventions to a redacted 500 "Internal error" — hit in production by a consumer's status-transition route), and log 5xx `ApiError`s in `createErrorHandler` so redacted responses leave a server-side trace.

## 0.7.0

### Minor Changes

- [`91cc6ed`](https://github.com/octabits-io/platform/commit/91cc6eddbd8a2d6a301a4166d6ea669a00740758) - feat(mail): add `requireTLS` override to the SMTP transport config

  `SmtpTransportConfig` now accepts an optional `requireTLS?: boolean`. It still
  defaults to `!secure` (STARTTLS required when implicit TLS is off, never
  downgrading to plaintext), but can be set to `false` to reach a plaintext
  dev/test SMTP server (Mailpit, Mailhog) that offers no TLS. Threaded through
  both `createSmtpTransport`/`createSmtpTransporter` and `verifySmtpConnection`.

### Patch Changes

- [`91cc6ed`](https://github.com/octabits-io/platform/commit/91cc6eddbd8a2d6a301a4166d6ea669a00740758) - fix(zitadel): classify "could not be found" and gRPC code 5 as `not_found`

  `classifyZitadelError` only matched the bare "not found" wording, so Zitadel's
  v2 query responses — "User could not be found" with gRPC status `NOT_FOUND`
  (code 5) — fell through to `api_error`. Callers relying on the `not_found`
  discriminator (e.g. `getUserById`) therefore misread a genuine miss as an
  opaque failure. The matcher now also recognises the "could not be found"
  phrasing and `"code":5`. Surfaced by a new integration test against a real
  Zitadel instance.

## 0.6.0

### Minor Changes

- [`e60f699`](https://github.com/octabits-io/platform/commit/e60f699e07e01c7be6260f05170e222021f7a616) - Add `./drizzle/backfill` — the one-shot data-backfill layer above SQL migrations: marker helpers (`ensureDataMigrationRunsTable` / `isDataMigrationCompleted` / `markDataMigrationCompleted`) over an on-demand `data_migration_runs` table, plus a `runBackfills` chain runner owning the skip / mark / partial-retry protocol for deploy pipelines.

- [`e60f699`](https://github.com/octabits-io/platform/commit/e60f699e07e01c7be6260f05170e222021f7a616) - Add `./zitadel` — typed client for the Zitadel Management API (users, orgs, project grants, roles, invites) with the `not_found` / `already_exists` / `missing_field` / `api_error` error taxonomy and `Result`-based returns. App-tier module; `wretch` (already an optional peer) is its vendor SDK. Generalized from its origin: `platformOnlyRoles` is injected config, grant searches return raw `ZitadelUserGrantEntry` shapes (domain mapping stays app-side), and the per-scope lookup ships de-tenanted as `findUserGrant`.

## 0.5.0

### Minor Changes

- [`bdf5650`](https://github.com/octabits-io/platform/commit/bdf5650fc6a2957ec6e449cb5126eb27611bf2e6) - feat(vault): `VAULT_CACERT` support for private CAs

  The vault client and `loadVaultSecrets` now accept a custom CA certificate for
  Vault servers behind a private CA (e.g. an in-cluster `vault-ca`):

  - `loadVaultSecrets` reads `VAULT_CACERT` (Vault CLI convention: a _path_ to a
    PEM-encoded CA certificate) and fails loud on an unreadable/empty file or a
    non-`https` `VAULT_ADDR`.
  - `authenticate` (k8s method) and `readKvV2` gain an optional `caCertPem`
    option (PEM contents).
  - When a CA is set, requests are dispatched via `node:https` instead of
    `fetch` — the only dependency-free mechanism that honors a custom CA on both
    Node and Bun. Behavior without `VAULT_CACERT` is unchanged.

## 0.4.0

### Minor Changes

- [`b57afc7`](https://github.com/octabits-io/platform/commit/b57afc7618acf7f93182713442a92d9728b5e438) - Database error mapping: SQLSTATE-carrying messages, broader code coverage, cause-chain walking

  `withDbErrorHandling` and `handleTransactionError` previously set `message` to the
  outer (Drizzle) error's message — typically just `Failed query: …` — dropping the
  actual PostgreSQL diagnosis that lives on `.cause`. Consumers that only surface
  `.message` (API responses, re-wrapped errors, test output) could not tell a
  deadlock from a unique violation.

  - The mapped `OctDatabaseError.message` is now prefixed with the raw SQLSTATE
    and, when distinct, the PostgreSQL error's own message:
    `[40P01 deadlock detected] Failed query: …`. The structured
    `code`/`constraint` fields are unchanged.
  - `PostgresErrorCode` gains four new mappings: `exclusion_violation` (23P01),
    `insufficient_privilege` (42501, incl. row-level-security policy violations),
    `lock_not_available` (55P03), and `query_canceled` (57014). These previously
    mapped to `unknown`.
  - `extractPgError` now walks the `cause` chain to a bounded depth instead of
    looking exactly one level deep, so a re-wrapped Drizzle error still maps
    instead of rethrowing.

## 0.3.1

### Patch Changes

- [`fc274ea`](https://github.com/octabits-io/platform/commit/fc274ead5423583626444fbd2122db794a1d372f) - `createFlowWorkflowRoutes`: the `/:id` routes' params schema is now loose (`z.looseObject`). The previous strict schema stripped parent path params (e.g. a mounting app's `/tenant/:tenantId`) during validation — before the consumer's request-scope plugin could read them — breaking get/status/cancel/resume for any consumer mounted under a parameterized prefix.

## 0.3.0

### Minor Changes

- [`16796d8`](https://github.com/octabits-io/platform/commit/16796d8c56225e0123bb050282431dd4d18db657) - `./elysia/flow`: consumer seams shaped by the second real consumer. `engine` now also accepts a per-request resolver `(ctx) => FlowEngineReader` for hosts with request-scoped, partition-bound engines; `authorize(action, ctx)` gates each route (return a keyed error — e.g. `forbidden` → 403); `extendWorkflow` gains an optional batched `load(workflows, ctx)` whose result is handed to `project(workflow, loaded)` (side-table joins run once per request, not per row); and map/sub-workflow child steps are now excluded from the wire step list by default (`includeChildSteps: true` opts back in) — children are engine mechanics, same philosophy as flow's status fold. All additive; existing `project(wf)` single-arg callers are unaffected.

## 0.2.0

### Minor Changes

- [`4be8d35`](https://github.com/octabits-io/platform/commit/4be8d359ca260c4fde6e254389248c97550a8fc7) - Add `./elysia/flow`: `createFlowWorkflowRoutes({ engine, … })` serves the generic read/control routes over an `@octabits-io/flow` engine (list, active-probe, get, status snapshot, cancel, resume) using flow's public wire view (`toPublicWorkflow` + `PUBLIC_WORKFLOW_SCHEMA`, flow ≥0.12), with declared response schemas for Eden/OpenAPI, `createErrorMapper`-based error mapping (`errorOverrides`), and an `extendWorkflow: { schema, project }` seam for consumer wire fields. `@octabits-io/flow` is a new optional peer confined to this subpath (same arrangement as `./elysia/mcp`); start/trigger routes remain app-side by design.

## 0.1.0

### Minor Changes

- [`4e0375e`](https://github.com/octabits-io/platform/commit/4e0375ead8429fe14a64bb3fdd16b7868077569c) - Initial release of the merged framework package. Supersedes `@octabits-io/{foundation,elysia,queue,storage,mail}` — imports map 1:1 onto subpaths (`foundation/<module>` → `framework/<module>`, the other four → `framework/<package>[/<sub>]`; see the README's migration table). One package, granular subpath exports, no root export; a boundary lint keeps the app modules (`elysia`, `queue`, `storage`, `mail`) from importing each other and confines each vendor SDK to its module. `elysia` and `pg-boss` are now optional peers (previously required); `zod` is the only required peer.

  Beyond the merge, this first release adds what consumers previously hand-rolled: a per-request IoC scope plugin for Elysia (`createRequestScopePlugin` — guaranteed disposal with commit/rollback semantics, `guard` seam, renameable context key, extras merging), the ioc↔rls bridge (`createGucScopeFactory`) plus `withScope`/`forEachScope` lifecycle helpers and GUC list-value guards, a bearer-auth plugin over the auth module's structural seam, `successResponses` (fixes Eden Treaty narrowing on non-200-success routes), 409/429 error-key conventions with `createErrorMapper`, a rate-limit `errorKey` option, `buildSwaggerOptions`, `assertNotInProduction`, `runElysiaServer`, a `./elysia/testing` subpath (`testRequest`/`testAuthenticatedRequest`), `MAIL_CONFIG_SCHEMA` + `createConfigParser` config fragments, `constantTimeEquals` in `./signing`, and `./drizzle/job-audit-store` (the Drizzle implementation of the queue module's DLQ-audit seam).
