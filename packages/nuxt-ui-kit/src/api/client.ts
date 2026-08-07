/**
 * Transport-agnostic API-client seams.
 *
 * The Eden Treaty factory that used to live here was removed with the Elysia
 * glue: consumers build their client with Hono's `hc` (ideally the pre-compiled
 * `hcWithType` the API package exports) and inject the bearer through `hc`'s own
 * async `headers` thunk. These two helpers were never Eden-specific and keep
 * their jobs — base-URL resolution and reading the token off the OIDC session.
 *
 * ```ts
 * import { hcWithType } from '@acme/admin-api/client';
 * const getToken = createAccessTokenProvider(getUserManager);
 * const client = hcWithType(getBaseUrl(), {
 *   headers: async () => {
 *     const token = await getToken();
 *     return token ? { authorization: `Bearer ${token}` } : {};
 *   },
 * });
 * ```
 */
import type { UserManager } from 'oidc-client-ts';

export interface ResolveApiBaseUrlOptions {
  /**
   * The explicitly configured URL, first-match-wins — e.g.
   * `__APP_CONFIG__.API_URL || runtimeConfig.public.apiUrl`. Falsy → fallback.
   */
  configuredUrl: string | null | undefined;
  /** Build-time production flag (`import.meta.env.PROD`). */
  isProductionBuild: boolean;
  /** Dev fallback becomes `http://localhost:<port>`. */
  devFallbackPort: number;
  /** Production fallback origin. Default `window.location.origin`. */
  origin?: string;
}

/**
 * Resolve the API base URL: configured value, else the page origin in
 * production builds (same-host ingress), else a localhost dev port.
 */
export function resolveApiBaseUrl(options: ResolveApiBaseUrlOptions): string {
  if (options.configuredUrl) return options.configuredUrl;
  return options.isProductionBuild
    ? (options.origin ?? window.location.origin)
    : `http://localhost:${options.devFallbackPort}`;
}

/**
 * Bearer-token provider backed by the OIDC session: resolves to the current
 * access token, or `null` when there is no non-expired session.
 */
export function createAccessTokenProvider(
  getUserManager: () => UserManager,
): () => Promise<string | null> {
  return async function getAccessToken(): Promise<string | null> {
    const user = await getUserManager().getUser();
    if (!user || user.expired) return null;
    return user.access_token;
  };
}
