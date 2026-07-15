/**
 * The kit's session core wrapped in the app's own Pinia store.
 *
 * This is the pattern the kit is built around: `createAuthSessionCore` returns
 * the *setup body* (refs + actions), and the app decides the store name,
 * registration, and any app-specific overrides. The kit itself has no Pinia
 * dependency.
 */
import { defineStore } from 'pinia'
import { createAuthSessionCore, defaultAuthUserMapper } from '@octabits-io/nuxt-ui-kit/auth'
import { getUserManager } from '~/lib/oidc'

export const useAuthStore = defineStore('auth', () => {
  const core = createAuthSessionCore({ getUserManager, mapUser: defaultAuthUserMapper })

  /**
   * Local-only sign-out.
   *
   * `core.logout()` ends with an OIDC `signoutRedirect` to the issuer's
   * end-session endpoint — correct against a real IdP, unreachable here. So the
   * demo keeps the half that works (`removeUser` + clear state) and lets the
   * caller navigate. `removeUser()` deletes the very storage entry the bypass
   * seeded, so the session is genuinely gone until /login re-seeds it.
   */
  async function logout() {
    await getUserManager().removeUser()
    core.user.value = null
  }

  return { ...core, logout }
})
