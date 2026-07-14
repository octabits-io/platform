# @octabits-io/nuxt-ui-kit

Frontend kit for Nuxt/Vue admin SPAs. Ships **factory-style seams** — the app
keeps thin plugin/store/middleware files and wires the kit into them; the kit
never touches Nuxt APIs (`defineNuxtPlugin`, `navigateTo`, `useRuntimeConfig`)
itself, so it has no Nuxt dependency, only `vue`.

> **Why "nuxt-ui-kit" when the root export is Nuxt-independent?** The name
> covers the package's full planned scope: a component tier built on Nuxt UI 4
> (confirm dialog, date-range input, sub-sidebar, AI-workflow harness) lands
> here next, behind subpaths with `@nuxt/ui` as an optional peer. The auth/API
> plumbing above is deliberately the kit's most portable layer — usable from
> any Vue SPA — but the package as a whole targets the Nuxt UI stack.

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

## Wiring sketch (Nuxt)

```ts
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
