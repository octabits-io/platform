/**
 * Hono port of the `./elysia` bearer-auth plugin (same contract, Hono idiom).
 *
 * The Elysia plugin's rejection seam is throw-based because a `resolve` hook
 * cannot short-circuit by returning. Hono middleware CAN return a `Response`,
 * so the seam simplifies: default rejections still throw `ApiError` (so the
 * shared error handler formats the standard body), but an `onUnauthorized`
 * returning a `Response` is now *returned*, not thrown — no error-handler
 * pass-through gymnastics involved.
 *
 * Structural contracts (`BearerTokenValidator`, `BearerAuthContext`,
 * `BearerAuthFailure`) are reused from the Elysia module unchanged.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { OctError } from '../result/index.ts';
import {
  ApiError,
  ForbiddenError,
  UnauthorizedError,
} from '../server/errors';
import {
  BUILTIN_BEARER_STATUS_OVERRIDES,
  type BearerAuthContext,
  type BearerAuthFailure,
  type BearerAuthStatus,
  type BearerTokenValidator,
} from '../server/bearer-auth';

export type { BearerAuthContext, BearerAuthFailure, BearerAuthStatus, BearerTokenValidator };

export interface BearerAuthMiddlewareOptions<TToken, TKey extends string = 'validatedToken'> {
  /** The validation service. Its token type flows through to `c.get(contextKey)`. */
  authService: BearerTokenValidator<TToken>;
  /** Context variable exposing the validated token. Default: `'validatedToken'`. */
  contextKey?: TKey;
  /**
   * Per-key status overrides, merged over the built-in
   * `{ jwks_unavailable: 503 }`. Unlisted keys are 401.
   */
  statusOverrides?: Record<string, BearerAuthStatus>;
  /**
   * Post-validation authorization (role/grant checks). `false` → 403
   * `ForbiddenError`. Throw from here instead of returning `false` when you
   * need a custom key/message.
   */
  authorize?: (token: TToken, ctx: BearerAuthContext) => boolean | Promise<boolean>;
  /**
   * Rejection mapper. A returned `Response` is sent as-is (the middleware
   * returns it — Hono's native short-circuit); any other return value
   * (typically a custom `Error`) is thrown for `app.onError` to format.
   */
  onUnauthorized?: (failure: BearerAuthFailure, ctx: BearerAuthContext) => unknown;
}

/** The Env contribution this middleware makes. */
export type BearerAuthEnv<TToken, TKey extends string = 'validatedToken'> = {
  Variables: Record<TKey, TToken>;
};

function bearerAuthContext(c: Context): BearerAuthContext {
  return { request: c.req.raw, path: c.req.path, params: c.req.param() as Record<string, string | undefined> };
}

/**
 * Build the bearer-auth middleware. Mount it on the sub-tree whose routes
 * require a valid token:
 *
 * ```ts
 * const app = new Hono<BearerAuthEnv<MyToken>>();
 * app.use(createBearerAuthMiddleware({ authService }));
 * app.get('/me', (c) => c.json({ subject: c.get('validatedToken').subject }));
 * ```
 */
export function createBearerAuthMiddleware<TToken, const TKey extends string = 'validatedToken'>(
  options: BearerAuthMiddlewareOptions<TToken, TKey>,
): MiddlewareHandler<BearerAuthEnv<TToken, TKey>> {
  const {
    authService,
    contextKey = 'validatedToken' as TKey,
    statusOverrides,
    authorize,
    onUnauthorized,
  } = options;

  const overrides: Record<string, BearerAuthStatus> = { ...BUILTIN_BEARER_STATUS_OVERRIDES, ...statusOverrides };

  const reject = async (
    status: BearerAuthStatus,
    error: OctError,
    ctx: BearerAuthContext,
  ): Promise<Response> => {
    if (onUnauthorized) {
      const outcome = await onUnauthorized({ status, error }, ctx);
      if (outcome instanceof Response) return outcome;
      throw outcome;
    }
    // The 503 key is normalized — `jwks_unavailable` is an internal detail, and
    // the client-facing contract for "auth provider down" is service_unavailable.
    if (status === 503) throw new ApiError(503, 'service_unavailable', error.message);
    if (status === 403) throw new ForbiddenError(error.message, error.key);
    throw new UnauthorizedError(error.message, error.key);
  };

  return async (c, next) => {
    const requestCtx = bearerAuthContext(c);
    const authHeader = c.req.raw.headers.get('authorization') ?? undefined;
    const result = await authService.validateAuthorizationHeader(authHeader);

    if (!result.ok) {
      return reject(overrides[result.error.key] ?? 401, result.error, requestCtx);
    }

    if (authorize && !(await authorize(result.value, requestCtx))) {
      return reject(403, { key: 'forbidden', message: 'Forbidden' }, requestCtx);
    }

    c.set(contextKey as never, result.value as never);
    await next();
  };
}
