/**
 * The app's `UserManager` singleton.
 *
 * `createUserManagerFactory` is lazy on purpose: `getConfig` runs at the first
 * `getUserManager()` call, not at import time, so it can read Nuxt's runtime
 * config. Plugin `10.oidc.client.ts` forces that first call while a Nuxt
 * context is guaranteed to exist; every later call returns the cached manager.
 *
 * The issuer here is never contacted — the demo has no IdP (see
 * `05.auth-bypass.client.ts`). The values still matter, because the
 * issuer/clientId pair is what keys the session entry in `localStorage`.
 */
import { createUserManagerFactory } from '@octabits-io/nuxt-ui-kit'

export const getUserManager = createUserManagerFactory({
  getConfig: () => {
    const config = useRuntimeConfig().public
    return { issuerUrl: config.oidcIssuerUrl, clientId: config.oidcClientId }
  },
  scope: 'openid profile email',
  // No IdP to renew against: leaving this on would have oidc-client-ts schedule
  // a silent-renew iframe against a host that does not exist.
  automaticSilentRenew: false,
})
