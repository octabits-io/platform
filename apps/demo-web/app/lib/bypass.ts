/**
 * The demo's stand-in for a login.
 *
 * `seedAuthBypassSession` writes an oidc-client-ts-shaped session into
 * `localStorage` under the key the `UserManager` reads (`oidc.user:<issuer>:
 * <clientId>`), so the kit's session core restores a real-looking session with
 * no IdP in the loop. The access token is the bypass secret, which the Eden
 * client then sends as `Authorization: Bearer …`.
 *
 * The refusal is build-time, not runtime: `isProductionBuild` must be
 * `import.meta.env.PROD`, so a leaked env var cannot switch the bypass on in
 * production output. That is also why `nuxt build` stays safe here — the seed
 * short-circuits to `false` before it touches storage.
 */
import { seedAuthBypassSession } from '@octabits-io/nuxt-ui-kit/auth'

/** Returns whether a session was seeded (false when one is already live). */
export function seedDemoSession(): boolean {
  const config = useRuntimeConfig().public
  return seedAuthBypassSession({
    bypassSecret: config.authBypassSecret,
    issuerUrl: config.oidcIssuerUrl,
    clientId: config.oidcClientId,
    isProductionBuild: import.meta.env.PROD,
    profile: {
      sub: 'demo-user',
      email: 'ada@demo.example',
      name: 'Ada Lovelace',
    },
  })
}
