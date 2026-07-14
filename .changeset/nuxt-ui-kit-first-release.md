---
'@octabits-io/nuxt-ui-kit': minor
---

First release (reynt extraction-catalog item 01 — the Phase B anchor): OIDC session harness over `oidc-client-ts` (`createUserManagerFactory`, stale-key cleanup, unrecoverable-renew classification, `createLoginRedirector`, `attachSessionLifecycleHandlers`, Zitadel scope presets), dev/E2E `seedAuthBypassSession` with an unconditional production-build refusal, `createAuthSessionCore` + `createOrgStoreCore` store cores (the app wraps them in its own Pinia stores), `createAuthGuard` route-guard builder with an injected per-app policy hook, and an Eden Treaty client factory (`createTreatyClientFactory`, bearer injection, `parseDate: false` default) with `createAccessTokenProvider` / `resolveApiBaseUrl`.
