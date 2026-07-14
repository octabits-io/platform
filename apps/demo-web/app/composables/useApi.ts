/**
 * The Eden Treaty client, typed end-to-end against the demo server.
 *
 * `App` is the *live* type of the running Elysia app — `@octabits-io/demo-server`
 * exports its TypeScript sources and its `exports.types` points at `src/app.ts`,
 * so route shapes are shared by type-checking rather than by a generated client.
 * Rename a response field on the server and this app stops compiling.
 *
 * Three kit seams do the work:
 *   - `resolveApiBaseUrl` — configured URL → page origin (prod) → localhost:3001
 *   - `createAccessTokenProvider` — bearer from the OIDC session (the bypass
 *     secret, here)
 *   - `createTreatyClientFactory` — lazy singleton; `parseDate: false` by
 *     default, which keeps `createdAt` a string on the wire instead of silently
 *     becoming a `Date` that re-serializes differently on the way back.
 */
import type { App } from '@octabits-io/demo-server'
import {
  createAccessTokenProvider,
  createTreatyClientFactory,
  resolveApiBaseUrl,
} from '@octabits-io/nuxt-ui-kit'
import { getUserManager } from '~/lib/oidc'
import { readDemoRole } from '~/composables/useDemoRole'

/** Also used for plain `<a href>` download links, which Eden cannot express. */
export function useApiBase(): string {
  return resolveApiBaseUrl({
    configuredUrl: useRuntimeConfig().public.apiBase,
    isProductionBuild: import.meta.env.PROD,
    devFallbackPort: 3001,
  })
}

const getClient = createTreatyClientFactory<App>({
  getBaseUrl: useApiBase,
  getAccessToken: createAccessTokenProvider(getUserManager),
  treatyConfig: {
    // The factory owns Treaty's `headers` option (that is where it injects the
    // bearer), so an extra per-request header goes through `onRequest`, whose
    // result Eden merges over the factory's headers.
    onRequest: () => ({ headers: { 'x-demo-role': readDemoRole() } }),
  },
})

export function useApi() {
  const client = getClient()
  return { api: client.api, client }
}
