/**
 * Framework-neutral bearer-auth contracts shared by the glue modules
 * (`./elysia`'s `createBearerAuthPlugin`, `./hono`'s
 * `createBearerAuthMiddleware`). The service seam is **structural** —
 * anything with a `validateAuthorizationHeader(header)` returning a `Result`
 * fits, including `…/auth`'s `createBearerAuthService` and
 * `createJwtValidationService` — so this module has no dependency on the auth
 * module.
 */
import type { OctError, Result } from '../result/index.ts';

/** The statuses bearer-auth glue can produce. */
export type BearerAuthStatus = 401 | 403 | 503;

/**
 * Structural contract for the injected validation service — satisfied by
 * `…/auth`'s `createBearerAuthService` and `createJwtValidationService`.
 */
export interface BearerTokenValidator<TToken> {
  validateAuthorizationHeader(header: string | undefined): Promise<Result<TToken, OctError>>;
}

/**
 * The request context handed to `authorize` / `onUnauthorized`. Structural
 * subset of a handler context — auth middleware mounts before routes, so
 * `params` are raw strings.
 */
export interface BearerAuthContext {
  request: Request;
  path: string;
  params: Record<string, string | undefined>;
}

/** Why the request was rejected, and with which status. */
export interface BearerAuthFailure {
  status: BearerAuthStatus;
  /**
   * The originating error. For a validation failure this is the service's own
   * error verbatim (e.g. `{ key: 'jwks_unavailable' }`); for an `authorize`
   * rejection it is the synthetic `{ key: 'forbidden' }`.
   */
  error: OctError;
}

/** The auth provider is unreachable — a server fault, not a client error. */
export const BUILTIN_BEARER_STATUS_OVERRIDES: Record<string, BearerAuthStatus> = {
  jwks_unavailable: 503,
};
