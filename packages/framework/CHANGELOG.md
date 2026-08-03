# @octabits-io/framework

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

- [`eb82de9`](https://github.com/octabits-io/platform/commit/eb82de9f01cd7bcfcdb187dbbd8fedd3e88e6849) - elysia errors: map `*_invalid_status` keys to 409 (they previously fell through the generic conventions to a redacted 500 "Internal error" — hit in production by reynt's booking-draft `mark-confirmed`), and log 5xx `ApiError`s in `createErrorHandler` so redacted responses leave a server-side trace.

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
