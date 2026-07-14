// SPA (`ssr: false`): these admin apps are client-rendered, which is also what
// the kit's OIDC harness assumes — `createUserManagerFactory` needs `window`
// and binds the session to `localStorage`.
export default defineNuxtConfig({
  compatibilityDate: '2026-07-14',
  ssr: false,
  devtools: { enabled: false },

  modules: ['@nuxt/ui', '@pinia/nuxt'],
  css: ['~/assets/css/main.css'],

  /**
   * Deliberately not 3000. When its port is taken Nuxt walks *upwards* to the
   * next free one — from 3000 that is 3001, the demo server's port. It will
   * happily bind there: Bun holds `*:3001` while Nuxt takes `[::1]:3001`, the
   * OS permits both, and `localhost` resolves to `::1` first — so the SPA
   * silently shadows the API it is trying to call, and every request returns
   * the app's own HTML. Starting at 3100 keeps the whole fallback range clear
   * of 3001.
   */
  devServer: { port: 3100 },

  runtimeConfig: {
    public: {
      /** Override with NUXT_PUBLIC_API_BASE. Empty → the kit's dev fallback. */
      apiBase: '',
      /**
       * Dev/E2E bypass secret. Non-empty → `seedAuthBypassSession` fakes a
       * session so the app is usable without an IdP. Ignored in production
       * builds — `seedAuthBypassSession` refuses on `import.meta.env.PROD`.
       */
      authBypassSecret: 'demo-bypass-token',
      /**
       * Never contacted: the demo has no IdP. The values only have to be
       * stable, because they key the OIDC session in `localStorage`
       * (`oidc.user:<issuer>:<clientId>`) — which is exactly the entry the
       * bypass seeds.
       */
      oidcIssuerUrl: 'https://idp.demo.invalid',
      oidcClientId: 'demo-web',
    },
  },

  typescript: {
    typeCheck: false,
    tsConfig: {
      compilerOptions: {
        // `@octabits-io/demo-server` exports its TypeScript sources directly
        // (no build step — Bun runs them), and those sources use the repo's
        // `.ts`-extension import convention. Eden's `App` type pulls them into
        // this program, so the flag has to be on here too.
        allowImportingTsExtensions: true,
      },
    },
  },

  /**
   * Force one physical copy of the UI stack.
   *
   * `typescript` is a peer of `@nuxt/ui` (and of `reka-ui` beneath it), so pnpm
   * keys a *separate* instance per resolved peer set. The kit resolves the
   * root's TypeScript 7; this app deliberately pins 5.9.3 so `vue-tsc` can run.
   * Two TS versions → two peer hashes → two `@nuxt/ui` + two `reka-ui` on disk:
   *
   *   packages/nuxt-ui-kit → .pnpm/@nuxt+ui@4.9.0_<hash A>  (typescript 7.0.2)
   *   apps/demo-web        → .pnpm/@nuxt+ui@4.9.0_<hash B>  (typescript 5.9.3)
   *
   * The kit ships its components as *source*, so when this app's Vite compiles
   * `…/nuxt-ui-kit/src/components/PeriodDisplay.vue`, its `@nuxt/ui` import
   * resolves from the kit's own directory — copy A — while the app's provider
   * tree comes from copy B. reka-ui's context keys are module-scoped `Symbol`s,
   * and symbols from different copies are never equal, so `PeriodDisplay`'s
   * `UTooltip` died with "Injection `Symbol(TooltipProviderContext)` not found"
   * *despite* a `TooltipProvider` sitting right above it in the tree.
   *
   * Deduping collapses both onto this app's copy. Publishing does not hit this
   * (`@nuxt/ui` is an optional *peer* of the kit, so a real consumer installs
   * exactly one) — it is a workspace artifact of the split TypeScript versions,
   * and it only bites source-shipped SFCs that inject provider context.
   */
  vite: {
    resolve: {
      dedupe: ['vue', 'vue-router', '@nuxt/ui', 'reka-ui'],
    },
  },

  future: { compatibilityVersion: 4 },
})
