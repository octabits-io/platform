/**
 * Seed the fake session before anything reads it — the auth store's
 * `checkAuth()` (via the global route middleware) is the first reader, and
 * plugins all run before the router.
 *
 * Client-only (`.client.ts`) because the seed writes `localStorage`. In this
 * SPA that is every plugin anyway, but the suffix keeps the intent explicit.
 */
import { seedDemoSession } from '~/lib/bypass'

export default defineNuxtPlugin(() => {
  seedDemoSession()
})
