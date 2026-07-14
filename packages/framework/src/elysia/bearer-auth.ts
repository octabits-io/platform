/**
 * Bearer-authentication plugin: the `resolve`-and-throw middleware every API
 * hand-rolls around a bearer/JWT validation service.
 *
 * Reads the `Authorization` header, hands it to the injected `authService`,
 * and either exposes the validated token on the route context or throws the
 * matching `ApiError`. The service seam is **structural** — anything with a
 * `validateAuthorizationHeader(header)` returning a `Result` fits, including
 * `…/auth`'s `createBearerAuthService` and `createJwtValidationService`. This
 * module therefore has no dependency on the auth module.
 *
 * Status selection is key-driven and follows the same override-first shape as
 * `./errors`: `jwks_unavailable → 503` is the only built-in rule (the auth
 * provider is temporarily unreachable — a server fault, not a bad token);
 * every other failure key is a 401 unless `statusOverrides` says otherwise.
 */
import { Elysia } from 'elysia';
import type { OctError, Result } from '../result/index.ts';
import { ApiError, ForbiddenError, UnauthorizedError } from './errors';

/** The statuses this plugin can produce. */
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
 * subset of Elysia's handler context — the plugin runs before routes, so
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

export interface BearerAuthPluginOptions<TToken, TKey extends string = 'validatedToken'> {
  /** The validation service. Its token type flows through to `ctx[contextKey]`. */
  authService: BearerTokenValidator<TToken>;
  /** Context property exposing the validated token. Default: `'validatedToken'`. */
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
   * Rejection mapper. **Its return value is thrown** in place of the default
   * `ApiError` — an Elysia `resolve` hook cannot short-circuit by *returning*
   * (the return value is merged into the context and the handler still runs),
   * so this seam is throw-based.
   *
   * Throwing a `Response` short-circuits with that exact response, which is how
   * a non-HTTP error envelope (e.g. a JSON-RPC error body) is returned:
   *
   * ```ts
   * onUnauthorized: ({ status, error }) => jsonRpcError(status, -32001, error.message)
   * ```
   *
   * Return any other value (typically a custom `Error`) to have your own
   * `onError` handler format it.
   */
  onUnauthorized?: (failure: BearerAuthFailure, ctx: BearerAuthContext) => unknown;
  /** Elysia plugin name (deduplication key). Default: `'bearer-auth'`. */
  name?: string;
}

/** The auth provider is unreachable — a server fault, not a client error. */
const BUILTIN_STATUS_OVERRIDES: Record<string, BearerAuthStatus> = {
  jwks_unavailable: 503,
};

/**
 * Build the bearer-auth plugin. Mount it on the sub-tree whose routes require
 * a valid token; the token type flows into `ctx.validatedToken`:
 *
 * ```ts
 * const auth = createBearerAuthPlugin({ authService: container.resolve('bearerAuthService') });
 *
 * new Elysia().use(auth).get('/me', ({ validatedToken }) => validatedToken.subject);
 * ```
 *
 * Gate a group on a role by adding `authorize`:
 *
 * ```ts
 * createBearerAuthPlugin({
 *   authService: jwtValidationService,
 *   authorize: (token) => isAdmin(token),
 *   name: 'require-admin',
 * });
 * ```
 *
 * The hook is `{ as: 'scoped' }`, so mount the plugin (it deduplicates by
 * `name`) in each route module that reads the token for the typing to flow.
 */
export function createBearerAuthPlugin<TToken, TKey extends string = 'validatedToken'>(
  options: BearerAuthPluginOptions<TToken, TKey>,
) {
  const {
    authService,
    contextKey = 'validatedToken' as TKey,
    statusOverrides,
    authorize,
    onUnauthorized,
    name = 'bearer-auth',
  } = options;

  const overrides: Record<string, BearerAuthStatus> = { ...BUILTIN_STATUS_OVERRIDES, ...statusOverrides };

  const reject = async (
    status: BearerAuthStatus,
    error: OctError,
    ctx: BearerAuthContext,
  ): Promise<never> => {
    if (onUnauthorized) throw await onUnauthorized({ status, error }, ctx);
    // The 503 key is normalized — `jwks_unavailable` is an internal detail, and
    // the client-facing contract for "auth provider down" is service_unavailable.
    if (status === 503) throw new ApiError(503, 'service_unavailable', error.message);
    if (status === 403) throw new ForbiddenError(error.message, error.key);
    throw new UnauthorizedError(error.message, error.key);
  };

  return new Elysia({ name }).resolve({ as: 'scoped' }, async (ctx) => {
    const requestCtx = ctx as unknown as BearerAuthContext;
    const authHeader = requestCtx.request.headers.get('authorization') ?? undefined;
    const result = await authService.validateAuthorizationHeader(authHeader);

    if (!result.ok) {
      await reject(overrides[result.error.key] ?? 401, result.error, requestCtx);
    }
    // `reject` always throws; narrow for the compiler.
    const token = (result as Extract<typeof result, { ok: true }>).value;

    if (authorize && !(await authorize(token, requestCtx))) {
      await reject(403, { key: 'forbidden', message: 'Forbidden' }, requestCtx);
    }

    return { [contextKey]: token } as { [K in TKey]: TToken };
  });
}
