/**
 * The kit's guard builder as a Nuxt global middleware.
 *
 * `createAuthGuard` knows nothing about Nuxt: it yields a redirect target or
 * `undefined`, and this file maps that onto `navigateTo`. The guard is built
 * once at module scope; the store is resolved lazily inside the callbacks,
 * where a Nuxt context is guaranteed.
 */
import { createAuthGuard } from '@octabits-io/nuxt-ui-kit/auth'
import { useAuthStore } from '~/stores/auth'

const guard = createAuthGuard({
  ensureAuthenticated: async () => {
    const auth = useAuthStore()
    // `checkAuth` restores the session from storage once per page load; every
    // later navigation reads the already-initialized store.
    if (!auth.initialized) await auth.checkAuth()
    return auth.isAuthenticated
  },
  /**
   * The per-app policy hook — where org validation, role gates, or an
   * acceptance flow would live. This app has none of those, so it only
   * normalizes the landing route.
   */
  afterAuthenticated: (to) => (to.path === '/' ? '/dashboard' : undefined),
})

export default defineNuxtRouteMiddleware(async (to) => {
  const target = await guard(to)
  if (target) return navigateTo(target)
})
