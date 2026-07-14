# @octabits-io/nuxt-ui-kit

Frontend kit for Nuxt/Vue admin SPAs. Ships **factory-style seams** — the app
keeps thin plugin/store/middleware files and wires the kit into them; the kit
never touches Nuxt APIs (`defineNuxtPlugin`, `navigateTo`, `useRuntimeConfig`)
itself, so it has no Nuxt dependency, only `vue`.

## What's inside

- **OIDC session harness** (`oidc-client-ts` peer)
  - `createUserManagerFactory({ getConfig, scope, … })` — lazy `UserManager`
    singleton bound to `localStorage`
  - `removeStaleOidcKeys`, `isUnrecoverableRenewError`
  - `createLoginRedirector` — signin redirect carrying the current path as
    returnUrl, with a `/login?redirect=` fallback
  - `attachSessionLifecycleHandlers` — classifies silent-renew failures /
    token expiry / back-channel signout into `notify` + `onSessionLost` +
    login-redirect callbacks; copy and toasts stay in the app
  - `ZITADEL_ORG_PROJECT_SCOPE` / `ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE`
    presets (Zitadel restricts refresh-grant scopes — see the constant's docs)
  - `seedAuthBypassSession` — dev/E2E bypass with an unconditional
    production-build refusal (`isProductionBuild` is a required argument)
- **Auth session store core** — `createAuthSessionCore` returns the setup body
  (`user`/`checkAuth`/`login`/`handleCallback`/`logout`, silent-renew retry,
  `id_token_hint` logout) for the app's own `defineStore('auth', …)`
- **Route guard builder** — `createAuthGuard` returns a handler yielding a
  redirect target or `undefined`; per-app policy (org validation, role gates)
  goes in the `afterAuthenticated` hook
- **Eden Treaty client factory** (`@elysiajs/eden` peer) —
  `createTreatyClientFactory<App>` (lazy singleton, bearer injection,
  `parseDate: false` by default to keep ISO-date strings string-typed on the
  wire), plus `createAccessTokenProvider` and `resolveApiBaseUrl`
- **Org store core** — `createOrgStoreCore<TOrg>` (granted orgs, slug-keyed
  selection, persistence, lost-access revocation) for the app's own store
- **API error → i18n** — `createApiErrorMessenger({ t, te })`: maps
  `{ key, message }` bodies and validation errors to user-facing strings via
  the `errors.*` / `validation.fields.*` / `validation.messages.*` key
  convention; unwraps Eden `{ value }` envelopes
- **Confirm dialog** — promise-based `useConfirm()` + singleton state, with a
  `./components/ConfirmDialog.vue` renderer (`common.cancel`/`common.confirm`
  i18n defaults, `zIndexClass` prop for stacking above slideovers)
- **Generic primitives** — `useDirtyTracking` (deep-compare form dirty state),
  `usePagination` (offset pagination with `queryParams`),
  `./components/SubSidebar.vue` (responsive list/detail layout — desktop
  column, mobile slideover, `selectionQueryKey` auto-close)
- **`./zod`** (`zod` peer) — `setupZodLocaleSync`: keep Zod's built-in error
  messages in the active UI language
- **`./dates`** (`date-fns` peer) — `Period`/`calculateDays`/`shiftIso`,
  `useDateRangeInput`, and `createDateFormatter({ getLocale })` (the engine of
  an app-side `useDateFormat`), plus source-shipped `./components/DateInput.vue`,
  `DateRangeInput.vue` (travel/booking end-date semantics, blocked dates via
  props, injected `availabilityCheck`), and `PeriodDisplay.vue`
- **`./ai`** — frontend AI-workflow engine: `useAiWorkflow` /
  `useAiWorkflowGuard` (poll-driven state over injected transport),
  `createAiProgressCore` (cross-page tracking + completion/applied signals —
  the setup body of the app's progress store), `useAiCardState`,
  `useActiveAiWorkflowProbe`, `createWorkflowRegistry`, and
  `./components/AiResultReviewCard.vue`; dialog/float shells stay in the app
  (thin views over this state, registry- and router-coupled)

## Components ship as source

`./components/*.vue` files are published as **`.vue` source** — the consumer's
Vite compiles them. They use only explicit imports (`@nuxt/ui/components/*.vue`,
`vue-i18n`, `vue-router`), so no auto-import configuration is required, and
they import kit composables from the **package root (self-reference)** so
module-scoped singleton state (the confirm dialog) is shared with feature
code. Register them under your app's own names with one-line re-exports:

```ts
// app/components/AppSubSidebar.ts
export { default } from '@octabits-io/nuxt-ui-kit/components/SubSidebar.vue'
```

## Wiring examples (Nuxt)

### Auth + API client

```ts
// app/plugins/10.oidc.client.ts
export const getUserManager = createUserManagerFactory({
  getConfig: () => ({ issuerUrl, clientId }),           // runtime config lookup
  scope: ZITADEL_ORG_PROJECT_SCOPE,
  refreshTokenAllowedScope: ZITADEL_REFRESH_TOKEN_ALLOWED_SCOPE,
})
export default defineNuxtPlugin((nuxtApp) => {
  attachSessionLifecycleHandlers(getUserManager(), {
    redirectToLogin: createLoginRedirector({ getUserManager }),
    onSessionLost: () => useAuthStore().$patch({ user: null }),
    notify: (notice) => toast.add(/* map notice.kind to your copy */),
  })
})

// app/composables/useApi.ts
const getClient = createTreatyClientFactory<App>({
  getBaseUrl: () => resolveApiBaseUrl({ configuredUrl, isProductionBuild: import.meta.env.PROD, devFallbackPort: 3002 }),
  getAccessToken: createAccessTokenProvider(getUserManager),
})

// app/stores/auth.ts
export const useAuthStore = defineStore('auth', () =>
  createAuthSessionCore({ getUserManager, mapUser: defaultAuthUserMapper }))

// app/middleware/auth.global.ts
const guard = createAuthGuard({ ensureAuthenticated, afterAuthenticated: appPolicy })
export default defineNuxtRouteMiddleware(async (to) => {
  const target = await guard(to)
  if (target) return navigateTo(target)
})
```

### Errors, confirm, formatting

```ts
// app/composables/useApiError.ts — bind your i18n instance
export function useApiError() {
  const { t, te } = useI18n()
  return createApiErrorMessenger({ t: key => t(key), te: key => te(key) })
}

// anywhere — the ConfirmDialog.vue renderer must be mounted once in a layout
const { confirm } = useConfirm()
if (await confirm({ title: t('owners.delete.title'), dangerous: true })) { /* … */ }

// app/composables/useDateFormat.ts
export function useDateFormat() {
  const { locale } = useI18n()
  return createDateFormatter({ getLocale: () => locale.value })
}
```

### AI workflows

```ts
// app/stores/aiProgress.ts — transport injected, signals consumed by pages
export const useAiProgressStore = defineStore('ai-progress', () =>
  createAiProgressCore<AiDialogRequest>({
    fetchWorkflowStatus: async (id) => {
      const { data, error } = await api.ai.workflows({ id }).get()
      return error || !data ? null : data
    },
  }))

// a page — rehydrate on mount, refuse duplicate triggers
const ai = useAiWorkflowGuard<MyOutput>({
  checkFn: fetchLatestWorkflow,
  pollFn: fetchLatestWorkflow,
  onCompleted: (wf) => showReview(wf.output),
})
await ai.trigger(() => api.ai.workflows.post({ type: 'listing-fields' }))
```
