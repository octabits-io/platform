---
'@octabits-io/nuxt-ui-kit': minor
---

Split the root barrel by peer weight and add small drops:

- **Breaking (pre-1.0 minor):** the OIDC harness moved to the new `./auth` subpath and the Eden Treaty client factory to `./api`. The root barrel keeps only the peer-light surface (composables, org store core), so importing a composable no longer welds `oidc-client-ts` / `@elysiajs/eden` to the consumer — both are now optional peers.
- `createTreatyClientFactory` accepts a `headers` option, layered after the bearer injector, so consumers can add or override headers without losing Authorization injection.
- New `resolveRuntimeConfigValue(appConfigKey, fallback?)` (root): the `window.__APP_CONFIG__` → build-time-fallback lookup, SSR-safe.
- New `./i18n` subpath: `kitMessagesEn` / `kitMessagesDe` / `kitMessagesDeFormal` fragments covering the `errors.*` keys of `createApiErrorMessenger` and the `auth.*` session-lifecycle keys (German in both du/Sie registers).
