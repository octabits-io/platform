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

Private workspace app. Never published.

## Run it

The server comes first — this app is a pure client and has no data of its own.

```bash
# 1. Postgres for the demo server
docker compose -f apps/demo-server/docker-compose.yml up -d --wait

# 2. The API on :3001
pnpm --filter @octabits-io/demo-server start

# 3. This app on :3100
pnpm install
pnpm --filter @octabits-io/demo-web dev
```

Then open <http://localhost:3100> — the bypass session is seeded automatically,
so you land on the dashboard with no login.

**Why 3100 and not 3000.** When its port is taken, Nuxt walks *upwards* to the
next free one, and from 3000 that is 3001 — the demo server's port. It binds
there quite happily: Bun holds `*:3001` while Nuxt takes `[::1]:3001`, the OS
permits both, and `localhost` resolves to `::1` first. The SPA then silently
shadows the API it is trying to call and every request returns the app's own
HTML. Starting at 3100 keeps the whole fallback range clear of 3001.

| Task | Command |
| --- | --- |
| Dev server | `pnpm --filter @octabits-io/demo-web dev` |
| Typecheck (incl. the kit's SFCs) | `pnpm --filter @octabits-io/demo-web typecheck` |
| Production build | `pnpm --filter @octabits-io/demo-web build` |

`NUXT_PUBLIC_API_BASE` overrides the API URL; unset, the kit's
`resolveApiBaseUrl` falls back to `http://localhost:3001` in dev.

## Auth: there is no IdP

The kit's OIDC harness expects a real identity provider. This demo has none, so
it leans on the kit's dev/E2E escape hatch:

- `app/lib/bypass.ts` calls **`seedAuthBypassSession`**, which writes an
  oidc-client-ts-shaped session into `localStorage` under the exact key a
  `UserManager` reads (`oidc.user:<issuer>:<clientId>`). The session's
  access token *is* the bypass secret, so the Eden client sends it as a bearer.
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
| `/dashboard` | Readiness probe, live pg-boss queue counts, settings summary, session chip. | Eden client, session store |
| `/contacts` | Server-paginated table; create + edit modals; blind-index email search; per-row welcome-email and delete. | `usePagination`, `useConfirm`, `useDirtyTracking`, `ConfirmDialog.vue` |
| `/notes` | List/detail: filter rail + note editor. Creation-date filter (single day or range) is client-side over the loaded list. | `SubSidebar.vue`, `DateInput.vue`, `DateRangeInput.vue`, `PeriodDisplay.vue`, `useDirtyTracking` |
| `/files` | Upload (multipart through Eden), list with size/content-type, download links. | Eden client, `resolveApiBaseUrl` |
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
app/composables/useApi.ts         createTreatyClientFactory + createAccessTokenProvider + resolveApiBaseUrl
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
| `createTreatyClientFactory` | `app/composables/useApi.ts` | ✅ |
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
| `./ai` (all) + `components/AiResultReviewCard.vue` | — | ❌ **The one real gap.** The engine polls a workflow-status endpoint (`fetchWorkflowStatus`, `pollFn`, trigger→poll→terminal); the demo server has no AI workflow routes and no LLM. Everything would be a mock talking to a mock, which documents nothing. Covering it needs server-side workflow routes first. |

**Not typechecked:** `AiResultReviewCard.vue` is the only kit SFC this app does
not import, so it is the only one still unchecked in-repo. The other five are
verified — each was probed with a deliberate type error and `nuxt typecheck`
caught all five.

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

### 2. Eden `data` does not narrow on 201/202-only routes (server-side, not fixed)

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

### 4. The kit's `createTreatyClientFactory` monopolises Treaty's `headers`

`treatyConfig` is typed `Omit<Treaty.Config, 'headers' | 'parseDate'>` because
the factory uses `headers` for bearer injection. An app needing an extra dynamic
header (here `x-demo-role`) must reach for `onRequest`, whose result Eden merges
over the factory's headers. That works and is what `useApi.ts` does, but it is
non-obvious. An `extraHeaders?: () => MaybePromise<Record<string, string>>`
option would be the natural seam.

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
different origin (`:3100`) than the API (`:3001`), so the browser preflighted
and the server — which had never wired `cors` — refused. `curl` sails through
unaffected because it does not enforce the same-origin policy. Fixed in
`apps/demo-server`: `cors()` now mounts through `createElysiaApp`'s `plugins`
seam (which the framework documents for exactly this), with `x-demo-role` in
`allowedHeaders` and `etag`/`content-disposition` in `exposeHeaders`. Origins
come from `CORS_ORIGINS` (default `http://localhost:3100`).

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
| API contract via Eden (create/list/blind-index search/welcome + idempotent replay/multipart upload/RBAC 403) | ✅ exercised against the running server |
| **In-browser render, all 5 pages** | ✅ Playwright: dashboard/contacts/notes/files/settings all render real API data (after #7) |
| **`useConfirm` → RBAC 403 → error messenger** | ✅ dialog opens, `viewer` delete returns 403, toast reads "Your demo role is not allowed to do that…" from `errors.forbidden` |
| **`useDirtyTracking`** | ✅ settings Save renders `[disabled]` until a field changes |
| **Queue + idempotency, end to end** | ✅ "send welcome" toasts a real `jobId` and flags the idempotent replay |
| **`DateRangeInput` + `PeriodDisplay`** | ✅ picking 7/1–7/31/2026 renders "7/1/2026 – 7/31/2026 · 31 days" and filters correctly (0 of 1 outside the range) — after #8 and #9 |
| **Browser console** | ✅ 0 errors, 0 warnings across all pages and the filter interaction |

Eden's multipart support was verified rather than assumed: a `File` in the body
switches it to `FormData`, which matches the server's `t.Object({ file: t.File() })`
— so `/files` uses the typed Eden call rather than a hand-rolled `fetch`.

**Still not verified:** a real OIDC login (no IdP — see *Auth* above), and the
`./ai` surface (no AI endpoint on the demo server). Both are honest gaps, not
oversights.
