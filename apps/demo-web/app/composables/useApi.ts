/**
 * The Hono `hc` client, typed end-to-end against the demo server.
 *
 * `App` is the *live* type of the running Hono app — `@octabits-io/demo-server`
 * exports its TypeScript sources and its `exports.types` points at `src/app.ts`,
 * so route shapes are shared by type-checking rather than by a generated client.
 * Rename a response field on the server and this app stops compiling.
 *
 * **`hcWithType`, not `hc<App>`.** The client type is derived by walking the
 * app's accumulated route schema, and `hc<App>(…)` re-does that walk at every
 * import site. `@octabits-io/demo-server/client` instantiates it once and
 * exports the finished type — Hono's documented mitigation, and the one thing
 * to copy from this file into a bigger consumer.
 *
 * Two kit seams still do their jobs (they were never Eden-specific):
 *   - `resolveApiBaseUrl` — configured URL → page origin (prod) → localhost:3101
 *   - `createAccessTokenProvider` — bearer from the OIDC session (the bypass
 *     secret, here)
 *
 * The kit's `createTreatyClientFactory` is what this file dropped. Its two jobs
 * map onto `hc` options directly:
 *   - lazy singleton → the module-level `client` below (`hc` builds no
 *     connection; constructing it early is free, so nothing is deferred)
 *   - bearer injection → `hc`'s own async `headers` thunk, which also absorbs
 *     the `x-demo-role` header that had to go through Eden's `onRequest`
 *     because the factory monopolised `headers` (demo-web finding #4 —
 *     the seam that finding asked for turns out to be `hc`'s default).
 *
 * `parseDate: false` has no counterpart: `hc` hands back exactly what
 * `res.json()` produced, so `createdAt` stays a string with nothing to opt out
 * of. That was Eden-specific behaviour, not an API contract.
 */
import { hcWithType } from '@octabits-io/demo-server/client'
import {
  createAccessTokenProvider,
  resolveApiBaseUrl,
} from '@octabits-io/nuxt-ui-kit/api'
import { getUserManager } from '~/lib/oidc'
import { readDemoRole } from '~/composables/useDemoRole'

/** Also used for plain `<a href>` download links, which the typed client cannot express. */
export function useApiBase(): string {
  return resolveApiBaseUrl({
    configuredUrl: useRuntimeConfig().public.apiBase,
    isProductionBuild: import.meta.env.PROD,
    devFallbackPort: 3101,
  })
}

const getAccessToken = createAccessTokenProvider(getUserManager)

let client: ReturnType<typeof hcWithType> | undefined

function getClient() {
  // Built on first use so `useApiBase()` runs inside a Nuxt app context
  // (`useRuntimeConfig`), never at module-evaluation time.
  client ??= hcWithType(useApiBase(), {
    headers: async () => {
      const token = await getAccessToken()
      return {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        // The demo's stand-in for a validated JWT role claim.
        'x-demo-role': readDemoRole(),
      }
    },
  })
  return client
}

export function useApi() {
  const c = getClient()
  return { api: c.api, client: c }
}
