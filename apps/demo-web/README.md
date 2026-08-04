# @octabits-io/demo-web

A small **contact desk** admin SPA that exercises
[`@octabits-io/nuxt-ui-kit`](../../packages/nuxt-ui-kit) against
[`@octabits-io/demo-server`](../demo-server). It has two jobs:

1. **Living documentation** — every kit seam is wired the way a real consumer
   wires it: thin plugin/store/middleware files with the kit's factories inside,
   never the kit reaching for Nuxt APIs.
2. **Typechecking the kit's SFCs** — the kit ships `./components/*.vue` as
   **source**, and the repo root runs TypeScript 7, where `vue-tsc` cannot run.
   So nothing in this repo type-checked those SFCs until this app existed. It
   pins its own TypeScript 5.x and runs `nuxt typecheck`.

That second job paid for itself immediately — see [Findings](#findings).

**Stack note (2026-08-04):** the API client moved from Eden Treaty to Hono's
`hc`, following `apps/demo-server`'s Elysia→Hono migration. The kit's
`createTreatyClientFactory` is unchanged and still shipped for Eden-based consumers — it
simply has no consumer here any more. What the swap cost, call site by call
site, is [Finding #10](#10-eden--hc-what-the-swap-actually-costs-2026-08-04).

Private workspace app. Never published.

## Run it

The server comes first — this app is a pure client and has no data of its own.

```bash
# 1. Postgres for the demo server
docker compose -f apps/demo-server/docker-compose.yml up -d --wait

# 2. The API on :3101
pnpm --filter @octabits-io/demo-server start

# 3. This app on :3100
pnpm install
pnpm --filter @octabits-io/demo-web dev
```

Then open <http://localhost:3100> — the bypass session is seeded automatically,
so you land on the dashboard with no login.

**The port-fallback trap.** When its port is taken, Nuxt walks *upwards* to
the next free one — and it will happily shadow a Bun server on the way: Bun
holds `*:PORT` while Nuxt takes `[::1]:PORT`, the OS permits both, and
`localhost` resolves to `::1` first. The SPA then silently shadows the API it
is trying to call and every request returns the app's own HTML. With the API
on 3101 — one step above this app's 3100 — that means: never start a second
demo-web instance while 3100 is taken, or the fallback lands exactly on the
API's port.

| Task | Command |
| --- | --- |
| Dev server | `pnpm --filter @octabits-io/demo-web dev` |
| Typecheck (incl. the kit's SFCs) | `pnpm --filter @octabits-io/demo-web typecheck` |
| Production build | `pnpm --filter @octabits-io/demo-web build` |

`NUXT_PUBLIC_API_BASE` overrides the API URL; unset, the kit's
`resolveApiBaseUrl` falls back to `http://localhost:3101` in dev.

## Auth: there is no IdP

The kit's OIDC harness expects a real identity provider. This demo has none, so
it leans on the kit's dev/E2E escape hatch:

- `app/lib/bypass.ts` calls **`seedAuthBypassSession`**, which writes an
  oidc-client-ts-shaped session into `localStorage` under the exact key a
  `UserManager` reads (`oidc.user:<issuer>:<clientId>`). The session's
  access token *is* the bypass secret, so the `hc` client sends it as a bearer.
- The refusal is **build-time, not runtime**: `isProductionBuild` must be
  `import.meta.env.PROD`, so a leaked env var cannot switch the bypass on in
  production output. `nuxt build` therefore stays safe — the seed
  short-circuits before touching storage. (The production build is verified in
  CI terms by `pnpm --filter @octabits-io/demo-web build` passing.)
- The issuer (`https://idp.demo.invalid`) is never contacted. It only has to be
  stable, because it keys the storage entry.
- `automaticSilentRenew` is **off** — with no IdP, leaving it on would have
  oidc-client-ts schedule renewal iframes against a host that does not exist.

Consequences worth knowing: `auth.logout()` is overridden in
`app/stores/auth.ts` to do the local half only (`removeUser` + clear state),
because the kit's `core.logout()` correctly ends with a `signoutRedirect` to an
end-session endpoint that does not exist here. And the full OIDC redirect flow
(`login` → `handleCallback`) is unreachable — see the coverage table.

## Page tour

| Route | What it shows | Kit surfaces exercised |
| --- | --- | --- |
| `/` | Nothing — the guard's policy hook redirects to `/dashboard` (or `/login`). | `createAuthGuard.afterAuthenticated` |
| `/login` | Public route. "Sign in" re-seeds the bypass session and honours `?redirect=`. | `seedAuthBypassSession` |
| `/dashboard` | Readiness probe, live pg-boss queue counts, settings summary, session chip. | `hc` client, session store |
| `/contacts` | Server-paginated table; create + edit modals; blind-index email search; per-row welcome-email and delete. | `usePagination`, `useConfirm`, `useDirtyTracking`, `ConfirmDialog.vue` |
| `/notes` | List/detail: filter rail + note editor. Creation-date filter (single day or range) is client-side over the loaded list. | `SubSidebar.vue`, `DateInput.vue`, `DateRangeInput.vue`, `PeriodDisplay.vue`, `useDirtyTracking` |
| `/files` | Upload (multipart through `hc`'s `form` input), list with size/content-type, download links. | `hc` client, `resolveApiBaseUrl` |
| `/settings` | Dirty-tracked settings form + the demo-role switch. Pick **viewer** and save to watch the server's 403 surface through the kit's error messenger. | `useDirtyTracking`, `createApiErrorMessenger` |

The flow worth following is the demo server's own: set **Welcome email subject**
on `/settings`, then hit **Send welcome email** on a contact in `/contacts` and
watch the server log print the rendered mail with your subject.

### Where the kit is wired

```
app/lib/i18n.ts          plain vue-i18n instance (no @nuxtjs/i18n — see below)
app/lib/oidc.ts          createUserManagerFactory
app/lib/bypass.ts        seedAuthBypassSession
app/plugins/01.i18n.ts   installs vue-i18n
app/plugins/02.zod-locale.ts      setupZodLocaleSync
app/plugins/05.auth-bypass.client.ts  seeds the fake session before anything reads it
app/plugins/10.oidc.client.ts     attachSessionLifecycleHandlers + createLoginRedirector
app/stores/auth.ts       createAuthSessionCore wrapped in the app's own Pinia store
app/middleware/auth.global.ts     createAuthGuard → navigateTo
app/composables/useApi.ts         hcWithType + createAccessTokenProvider + resolveApiBaseUrl
app/composables/useApiCall.ts     call() — hc Response -> the { data, error } envelope
app/composables/useApiError.ts    createApiErrorMessenger bound to vue-i18n
app/composables/useDateFormat.ts  createDateFormatter bound to vue-i18n
app/components/App*.ts   one-line re-exports registering the kit's SFCs
```

**Plain vue-i18n, not `@nuxtjs/i18n`.** The kit's seams only need a
`t`/`te`/`locale` triple, and the demo ships one locale — the module's
routing/lazy-loading/SEO machinery would be weight without a job. `createI18n` +
`vueApp.use()` is the whole integration.

## Kit coverage

| Export | Where | Covered |
| --- | --- | --- |
| `createUserManagerFactory` | `app/lib/oidc.ts` | ✅ |
| `seedAuthBypassSession` | `app/lib/bypass.ts` | ✅ |
| `createAuthSessionCore` + `defaultAuthUserMapper` | `app/stores/auth.ts` | ✅ |
| `createAuthGuard` | `app/middleware/auth.global.ts` (incl. the `afterAuthenticated` policy hook) | ✅ |
| `attachSessionLifecycleHandlers` | `app/plugins/10.oidc.client.ts` | ⚠️ wired for real, but with no IdP the events never fire |
| `createLoginRedirector` | `app/plugins/10.oidc.client.ts` | ⚠️ same |
| `createTreatyClientFactory` | — | ❌ **since 2026-08-04**: this app moved to Hono's `hc` with the server. The kit export is unchanged and still shipped for Eden-based consumers; it simply has no consumer here. Its two jobs map onto `hc` options directly — see [Findings #4](#4-the-kits-createtreatyclientfactory-monopolises-treatys-headers-obsolete-here). |
| `createAccessTokenProvider` | `app/composables/useApi.ts` | ✅ |
| `resolveApiBaseUrl` | `app/composables/useApi.ts` (also for `<a href>` downloads) | ✅ |
| `createApiErrorMessenger` | `app/composables/useApiError.ts`; 403 path on `/settings` | ✅ |
| `useConfirm` / `useConfirmState` | `/contacts` + `/notes` delete; `ConfirmDialog` mounted once in the layout | ✅ |
| `useDirtyTracking` | `/settings`, `/contacts` edit, `/notes` editor (incl. `getDirtyFields()`) | ✅ |
| `usePagination` | `/contacts` | ⚠️ partial — see findings |
| `./zod` `setupZodLocaleSync` | `app/plugins/02.zod-locale.ts` | ✅ |
| `./dates` `createDateFormatter` | `app/composables/useDateFormat.ts` — all date rendering | ✅ |
| `./dates` `Period` / `calculateDays` / `shiftIso` | via `DateRangeInput` + `PeriodDisplay` | ✅ (indirect) |
| `components/ConfirmDialog.vue` | `app/components/AppConfirmDialog.ts` | ✅ |
| `components/SubSidebar.vue` | `/notes` list/detail shell | ✅ |
| `components/DateInput.vue` | `/notes` "on a day" filter | ✅ |
| `components/DateRangeInput.vue` | `/notes` "in a range" filter | ✅ verified in-browser (findings #8/#9 — it emits a *new* `Period`, so the binding must be a `ref`) |
| `components/PeriodDisplay.vue` | `/notes` active-range echo | ✅ verified in-browser — but it had **never once mounted** until #8/#9 were fixed; its `UTooltip` needs a deduped `@nuxt/ui` |
| `ZITADEL_*` scope presets | — | ❌ Zitadel-specific; the demo's issuer is fictional, so a preset would assert a relationship that does not exist. |
| `removeStaleOidcKeys` / `isUnrecoverableRenewError` | — | ❌ Both address multi-environment/renewal realities that need a real IdP. `isUnrecoverableRenewError` is used *inside* `attachSessionLifecycleHandlers` regardless. |
| `createOrgStoreCore` | — | ❌ Needs an orgs/grants endpoint. The demo server is single-scope by design (no tenant vocabulary anywhere in it), so there is nothing to list or switch between. Faking one would document a shape the API does not have. |
| OIDC redirect flow (`login`, `handleCallback`) | — | ❌ Needs a real IdP. `/login` calls `checkAuth()` after re-seeding instead, which is the same code path the guard uses. |
| `useDateRangeInput` (`./dates`) | — | ❌ Bridges separate start/end refs to a `Date[]` range picker. `DateRangeInput.vue` already owns that bridge internally, and this app has no raw range picker. |
| `formatCurrency` / `formatCheckoutDate` / `formatTimeFromString` (`./dates`) | — | ❌ No money and no check-in/check-out domain in a contact desk. `formatCheckoutDate` *is* exercised indirectly by `PeriodDisplay`. |
| `./ai` — `useAiWorkflowGuard` (and `useAiWorkflow` inside it) | [`components/AiContactBrief.vue`](./app/components/AiContactBrief.vue) — `checkFn`/`pollFn` both read "latest workflow for this entity" (`GET /api/ai/workflows?entityRef=…&limit=1`); rehydration verified in-browser: the modal resumed a run triggered by `curl` before the page ever loaded | ✅ verified in-browser |
| `./ai` — `createAiProgressCore` | [`stores/aiProgress.ts`](./app/stores/aiProgress.ts) — the core-in-a-Pinia-store pattern (same as `stores/auth.ts`); feeds the contacts navbar "AI running" badge across modal close | ✅ verified in-browser |
| `./events` — `useEventStream` (and `createEventStreamClient`/`createSseFrameParser` inside it) | [`pages/events.vue`](./app/pages/events.vue) — one stream for the page's lifetime against `/api/events/stream`; reactive state badge, both lanes rendered live, dedupe + `Last-Event-ID` replay observable by emitting durable events across a reconnect | ✅ |
| `./ai` — `useActiveAiWorkflowProbe` | `AiContactBrief.vue` — disables the trigger while a run is in flight (`GET /api/ai/workflows/active`) | ✅ |
| `./ai` — `useAiCardState` | `AiContactBrief.vue` — idle/active/failed chip over the progress store | ✅ |
| `./ai` — `createWorkflowRegistry` | [`lib/aiWorkflows.ts`](./app/lib/aiWorkflows.ts) — app-owned definition shape; labels the modal title | ✅ |
| `components/AiResultReviewCard.vue` | [`AppAiResultReviewCard.ts`](./app/components/AppAiResultReviewCard.ts) re-export in `AiContactBrief.vue` — review-then-apply; "apply" is a domain write (creates a note via `POST /api/notes`) plus `markApplied` | ✅ verified in-browser |

The server side of the seam is [`apps/demo-server/src/routes/ai.ts`](../demo-server/src/routes/ai.ts)
(`@octabits-io/flow` + the `ai/test` mock model — no API key involved); the
route serializes flow's `WorkflowWithSteps` into exactly the kit's
`AiWorkflowData` shape, so the whole transport contract is those two files.

**Typechecked:** with `AiResultReviewCard.vue` adopted, **every** kit SFC is now
imported here and covered by `nuxt typecheck`. The other five were verified
earlier — each probed with a deliberate type error, all five caught.

## Findings

Things this app surfaced that are worth acting on.

### 1. `SubSidebar.vue` had a real type error (fixed — kit was edited)

`node_modules/@octabits-io/nuxt-ui-kit/src/components/SubSidebar.vue(76,14):
error TS2322`. The mobile toggle used an inline `@click="open = true"`, which
Vue compiles to `$event => (open = true)` — return type `boolean`. `UButton`
types `onClick` as `(event) => void | Promise<void>`, and because that is a
*union* rather than bare `void`, TypeScript's "a value-returning function is
assignable to a void-returning signature" rule does not apply. Assignment fails.

Fixed in `packages/nuxt-ui-kit` (a named `openSidebar()` handler) with a
changeset, because it blocked this app's headline deliverable. **This is the
first kit SFC type error ever caught in-repo** — the exact class of bug that was
invisible while no consumer could run `vue-tsc`.

Only `SubSidebar` was affected: the similar inline assignments in
`DateRangeInput.vue` are on plain `<div>`/`<span>` elements, whose native
handler types accept any return.

### 2. Eden `data` does not narrow on 201/202-only routes (historical)

> **Fixed 2026-07-14:** the framework now ships `successResponses(status, schema)`, the demo-server routes adopted it, and the `'in' data` guards this finding forced are gone from this app.
>
> **Moot since 2026-08-04:** the whole failure mode was Elysia+Eden-specific — it came from Elysia *inferring* a 200 entry out of the handler's return union. Hono declares no such phantom status, so `POST /api/files` and `POST /api/contacts/:id/welcome` narrow on their own. `successResponses` stays in the route declarations because the OpenAPI document is better for it, but it is documentation now, not a workaround. Kept below because the reasoning is the clearest record of what Eden's `data`/`error` split actually did.


On the demo server, routes whose only declared success code is `201`/`202` —
`POST /api/files`, `POST /api/contacts/:id/welcome` — leak the error body into
Eden's success type, so `if (error) return` does **not** narrow `data`:

```
Property 'jobId' does not exist on type
  'ErrorResponseBody | { jobId: string; queue: string; replayed: boolean } | …'
```

Cause: the handlers return `statusErrorWithSet(...)` on their failure paths, and
because no explicit `200` is declared, Elysia infers a `200` entry **from the
handler's return-type union** — error body included. Eden reads `data` as
`Res[Extract<keyof Res, SuccessCodes>]` where `SuccessCodes` covers `200 | 201 |
202`, so the inferred `200` is folded in. Routes that declare an explicit `200:`
(list, search, settings) narrow cleanly.

Left as-is here — the fix belongs to the server's route/`statusErrorWithSet`
design, not to a frontend workaround. This app narrows with a commented
`if (!('jobId' in data)) return` and flags it. Worth a look from the framework
side: the `statusErrorWithSet` + `errorResponses` pattern makes every
non-200-success route do this.

### 3. `usePagination`'s `queryParams` assumes a limit/offset API

The composable exposes `queryParams { limit, offset }` ready to spread, but the
demo server paginates by `page`/`pageSize` (as do plenty of APIs). So `/contacts`
uses the `page`/`itemsPerPage` refs and ignores `queryParams` entirely. Not a
bug — but the ergonomic payload only lands for half the API conventions out
there. A `mapQueryParams` seam (or documenting the refs as the real interface)
would help.

### 4. The kit's `createTreatyClientFactory` monopolises Treaty's `headers` (obsolete here)

`treatyConfig` is typed `Omit<Treaty.Config, 'headers' | 'parseDate'>` because
the factory uses `headers` for bearer injection. An app needing an extra dynamic
header (here `x-demo-role`) must reach for `onRequest`, whose result Eden merges
over the factory's headers. That works and is what `useApi.ts` does, but it is
non-obvious. An `extraHeaders?: () => MaybePromise<Record<string, string>>`
option would be the natural seam.

> **Resolved by the move to `hc` (2026-08-04), not by a kit change.** `hc` takes
> a single async `headers` thunk, so bearer *and* `x-demo-role` are produced by
> the same function and the `onRequest` detour is gone — the seam this finding
> asked for turns out to be `hc`'s default. The kit factory is untouched and
> still shipped for Eden-based consumers; for an app staying on Eden, the `extraHeaders` option
> above is still the right addition.

### 5. `useConfirm`'s singleton survives the package boundary (verified, no action)

The design depends on the SFC's self-referencing `@octabits-io/nuxt-ui-kit`
import resolving to the same module instance as feature code's import. Verified
in dev — both compile to the identical specifier
(`/_nuxt/@fs/…/packages/nuxt-ui-kit/dist/index.js`), so Vite dedupes them to one
module and one dialog. The "mount the renderer once" rule holds.

### 6. Kit peer warning at install (cosmetic)

`pnpm install` warns `@nuxt/ui 4.9.0 → unmet peer typescript@"^5.6.3 || ^6.0.0":
found 7.0.2` **for `packages/nuxt-ui-kit`**, which resolves the root's TS 7. It
is exactly the constraint that makes this app necessary, and it does not affect
`demo-web` (pnpm gives it its own TS 5.9.3). Noted so nobody "fixes" it by
downgrading the root.

### 7. Three bugs that only a browser could find

The first click-through found three defects that `typecheck`, `build`, and
`curl /` all reported as green. They are recorded together because they share a
moral: **for an `ssr: false` SPA, `curl /` proves only that Nuxt can serve an
empty shell.** It cannot distinguish a working app from a blank page.

**(a) No CORS on the demo server → every API call blocked.** The SPA is a
different origin (`:3100`) than the API (`:3101`), so the browser preflighted
and the server — which had never wired `cors` — refused. `curl` sails through
unaffected because it does not enforce the same-origin policy. Fixed in
`apps/demo-server`: `cors()` (now Hono's own `hono/cors`, in `createHonoApp`'s
`middleware` array) with `x-demo-role` in `allowHeaders` and
`etag`/`content-disposition` in `exposeHeaders`. Origins come from
`CORS_ORIGINS` (default `http://localhost:3100`). The moral repeated itself
during the Hono migration on the server's own Swagger page — a wrong CSP host
is another thing only a browser will tell you.

**(b) `UDashboardPanel`'s named slots are default-slot *fallback*.** The
component renders:

```vue
<slot>                       <!-- default -->
  <slot name="header" /><slot name="body" /><slot name="footer" />
</slot>
```

`contacts.vue` declared its two `<UModal>`s as direct children of the panel.
That is default-slot content, so it **replaced the entire header/body tree** —
and because a modal teleports itself to `<body>`, the panel rendered to
literally nothing. No error, no Vue warning, no type error: the page setup ran
fine and the data loaded (8 rows in memory), but the DOM was empty. Fixed by
moving the modals inside `<template #body>`. Worth knowing before writing the
next page — any stray child of `UDashboardPanel` silently blanks it.

**(c) A raw `@` in a vue-i18n message is linked-message syntax.** The locale had
`"placeholder": "ada@example.com"`, which vue-i18n compiles as a *linked
message* and rejects: `Message compilation error: Invalid linked format`. It
must be escaped `"ada{'@'}example.com"` — as the file's own `tagline` key
already did, so the trap was known and simply missed once. This one was
**masked by (b)**: the blank panel meant the placeholder never compiled, so
fixing (b) is what surfaced it. Every `@` in `app/locales/en.json` is now
escaped.

### 8. `v-model` on a `reactive()` silently breaks the binding

`notes.vue` held its range filter in `reactive<Period>({ start: '', end: '' })`
and bound it with `v-model`. But `DateRangeInput` emits a **new object**
(`emit('update:modelValue', { start, end })`), and `v-model` *assigns* to the
binding — which `reactive` cannot absorb. The SFC compiler papers over it with a
warning most people never read:

```
v-model cannot update a const reactive binding filterPeriod.
The compiler has transformed it to let to make the update work.
```

The assignment then lands on a plain `let` that `periodIsComplete` does not
track, so the computed never re-fired: **both dates could be picked and the
filter never engaged** — a Jan-2020 range still "matched" a Jul-2026 note. Fixed
by using `ref<Period>`, the assignable box `v-model` actually wants. Rule of
thumb: a `v-model` target is a `ref`; `reactive` is for objects you *mutate*
(like `editorState`, which is still `reactive` here and correct).

### 9. Two `@nuxt/ui` copies broke the kit's `PeriodDisplay` (workspace-only)

Finding #8 was masking this one: with the filter never completing,
`PeriodDisplay` (rendered under `v-if="periodIsComplete"`) had **never actually
mounted**. The moment it did, it threw:

```
Injection `Symbol(TooltipProviderContext)` not found.
Component must be used within `TooltipProvider`
```

— while a `TooltipProvider` sat right above it in the component tree. The cause
is two physical copies of the UI stack:

| Resolver | Instance | Peer-hashed against |
| --- | --- | --- |
| `packages/nuxt-ui-kit` | `.pnpm/@nuxt+ui@4.9.0_00acaae4…` | typescript **7.0.2** (root) |
| `apps/demo-web` | `.pnpm/@nuxt+ui@4.9.0_04b1a366…` | typescript **5.9.3** (this app's pin) |

`typescript` is a peer of `@nuxt/ui`/`reka-ui`, so pnpm keys a separate instance
per peer set. Because the kit ships components as **source**, this app's Vite
compiles `nuxt-ui-kit/src/components/PeriodDisplay.vue` with `@nuxt/ui`
resolved from *the kit's* directory — a different copy than the one that
rendered the provider. reka-ui's context keys are module-scoped `Symbol`s, and
symbols from two copies never compare equal.

Fixed with `vite.resolve.dedupe: ['vue', 'vue-router', '@nuxt/ui', 'reka-ui']`
in `nuxt.config.ts`. **This is a workspace artifact, not a kit defect**: on npm,
`@nuxt/ui` is an optional *peer* of the kit, so a real consumer installs exactly
one copy. It is caused here by the very TypeScript split that makes this app
necessary (root TS 7 vs. this app's TS 5.9.3 for `vue-tsc`). Worth knowing
because it hits **any** source-shipped SFC that injects provider context —
`ConfirmDialog` survives only because `UModal` needs no such injection.

## Verification status

| Check | Result |
| --- | --- |
| `pnpm --filter @octabits-io/demo-web typecheck` | ✅ exit 0, 0 errors (after finding #1) |
| `pnpm --filter @octabits-io/demo-web build` | ✅ exit 0 — the bypass's production refusal does not break it |
| `pnpm --filter @octabits-io/demo-server typecheck` | ✅ exit 0 (after the CORS wiring in #7a) |
| Kit SFCs compile through the app's Vite | ✅ all 5 imported SFCs return compiled output |
| Kit SFCs are in the typecheck program | ✅ probed each with a deliberate error; all 5 caught |
| API contract via `hc` (create/list/blind-index search/welcome + idempotent replay/multipart upload/RBAC 403) | ✅ re-exercised in-browser against the running server after the Hono migration |
| **In-browser render, all 5 pages** | ✅ Playwright: dashboard/contacts/notes/files/settings all render real API data (after #7) |
| **`useConfirm` → RBAC 403 → error messenger** | ✅ dialog opens, `viewer` delete returns 403, toast reads "Your demo role is not allowed to do that…" from `errors.forbidden` |
| **`useDirtyTracking`** | ✅ settings Save renders `[disabled]` until a field changes |
| **Queue + idempotency, end to end** | ✅ "send welcome" toasts a real `jobId` and flags the idempotent replay |
| **`DateRangeInput` + `PeriodDisplay`** | ✅ picking 7/1–7/31/2026 renders "7/1/2026 – 7/31/2026 · 31 days" and filters correctly (0 of 1 outside the range) — after #8 and #9 |
| **Browser console** | ✅ 0 errors, 0 warnings across all pages and the filter interaction |

Multipart was re-verified rather than assumed after the migration: `hc`'s
`form` input serialises a `File` to `FormData`, which matches the server's
`octApiValidator('form', z.object({ file: z.file() }))` — so `/files` still uses
the typed call rather than a hand-rolled `fetch`. (Both ends dropped a schema
language in the process: the server route was this repo's last TypeBox use.)

**Still not verified:** a real OIDC login (no IdP — see *Auth* above). The
`./ai` surface — previously the other honest gap — is now covered end to end:
trigger → parallel steps → review card → apply-creates-note, verified headless
in-browser with zero console errors.

### 10. Eden → `hc`: what the swap actually costs (2026-08-04)

The whole client migration, for the record — the reference for anyone
weighing the same swap.

**Call-site shape.** 23 call sites, all mechanical, none restructured. Eden's
`{ data, error }` envelope has no `hc` equivalent (`hc` resolves to a typed
`Response`), so [`useApiCall.ts`](./app/composables/useApiCall.ts) puts it back
in ~20 lines and every site kept its `if (error) { toastError(error); return }`
shape. Without it each site would have grown three lines and an easy-to-forget
`await res.json()`. The mapping:

| Eden | `hc` |
| --- | --- |
| `api.contacts.get({ query })` | `call(api.contacts.$get({ query }))` |
| `api.contacts.post({ ...body })` | `call(api.contacts.$post({ json: body }))` |
| `api.contacts({ id }).put(body)` | `call(api.contacts[':id'].$put({ param: { id }, json: body }))` |
| `api.contacts({ id }).welcome.post()` | `call(api.contacts[':id'].welcome.$post({ param: { id } }))` |
| `api.files.post({ file })` | `call(api.files.$post({ form: { file } }))` |
| `{ data, error }`, `data` narrowed by `if (error)` | identical, via `call()` |
| `error` is `{ status, value }` | identical — `call()` keeps that shape on purpose |

Two real differences behind the table: **path params move into an explicit
`param` object** keyed by the literal route pattern (`[':id']`, not `({ id })`),
and **query values are strings** — `hc` serialises them verbatim, so a page
passes `{ pageSize: String(n) }` and the route's `z.coerce.number()` converts.

**What got simpler.** `parseDate: false` has no counterpart to set — `hc`
returns exactly what `res.json()` produced, so dates stay strings by
construction. Bearer + `x-demo-role` collapse into one async `headers` thunk
(see Finding #4). And Eden's 201/202 narrowing bug (Finding #2) does not exist.

**What to watch, and the trap worth the whole section.** `hc`'s client type is
derived by walking the app's route schema, and it is *deep*. Three separate
ways to lose or break it turned up here, all silent at runtime:

- A framework factory annotating its return as `Hono` erases every route from
  the client type. The app still serves; `hc<App>` just has no properties.
- Deriving a route's response type from a zod schema built over an unresolved
  generic (`…/hono/flow`'s workflow view did) carries the whole unevaluated
  conditional into every route's output. **TypeScript 7 absorbs it; TypeScript
  6 — which this app pins, because `vue-tsc` needs it — blows its call stack**
  on `hc<App>`, and on the bare `App` type. `nuxt typecheck` died with
  `RangeError: Maximum call stack size exceeded` and no file name.
- Filtering a response union on `{ ok: true }` silently yields `never`: a
  handler returning `c.json(value)` with no explicit status gets the wide
  `ContentfulStatusCode`, so `ok` widens to `boolean`. `call()` therefore
  filters *by exclusion* (`R extends { ok: false } ? never : …`).

All three were fixed in `@octabits-io/framework` with tests pinning them, so a
consumer starting today does not meet them — but they are the shape of the
failure to expect when composing a large Hono app, and the reason
[`@octabits-io/demo-server/client`](../demo-server/src/client.ts) instantiates
`hc<App>` **once** (Hono's documented mitigation) instead of at each import.

### AI wiring gotcha: `@` in vue-i18n messages

`@` starts a *linked message* in vue-i18n's message syntax, so a locale string
containing a bare `@octabits-io/flow` throws `Message compilation error:
Invalid linked format` **at render time** — `nuxt typecheck` is green, the
modal just comes up empty. Escape it as `{'@'}octabits-io/flow` (see
`ai.brief.intro` in `locales/en.json`).
