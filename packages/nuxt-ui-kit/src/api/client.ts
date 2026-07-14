import { treaty, type Treaty } from '@elysiajs/eden';
import type { Elysia } from 'elysia';
import type { UserManager } from 'oidc-client-ts';

type AnyElysia = Elysia<any, any, any, any, any, any, any>;

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

export interface TreatyClientFactoryOptions {
  /** Resolve (and memoize, if desired) the base URL at first client use. */
  getBaseUrl: () => string;
  /** Bearer token per request; `null` sends no Authorization header. */
  getAccessToken: () => Promise<string | null>;
  /**
   * Eden Treaty's auto-Date parsing on responses. Default `false`: with the
   * default `true`, any `YYYY-MM-DD` string in a response is silently
   * converted to a `Date` object, which then JSON-serializes back as a full
   * ISO datetime on the next request — breaking server-side "plain ISO date
   * string" validation. Keep the wire contract string-typed unless the API
   * genuinely round-trips Date objects.
   */
  parseDate?: boolean;
  /** Extra Treaty config (fetcher, onRequest, …), applied last. */
  treatyConfig?: Omit<Treaty.Config, 'headers' | 'parseDate'>;
}

/**
 * Lazily-created Eden Treaty client singleton with OIDC bearer injection.
 *
 * ```ts
 * const getClient = createTreatyClientFactory<App>({ getBaseUrl, getAccessToken })
 * export function useApi() {
 *   const client = getClient()
 *   return { api: client.api, client }
 * }
 * ```
 */
export function createTreatyClientFactory<App extends AnyElysia>(
  options: TreatyClientFactoryOptions,
): () => Treaty.Create<App> {
  let client: Treaty.Create<App> | null = null;

  return function getClient(): Treaty.Create<App> {
    if (client) return client;

    client = treaty<App>(options.getBaseUrl(), {
      parseDate: options.parseDate ?? false,
      headers: async () => {
        const token = await options.getAccessToken();
        if (token) {
          return { authorization: `Bearer ${token}` } as Record<string, string>;
        }
        return undefined;
      },
      ...options.treatyConfig,
    });

    return client;
  };
}
