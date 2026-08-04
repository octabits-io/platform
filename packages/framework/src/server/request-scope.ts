/**
 * Framework-neutral request-scope contracts shared by the glue modules
 * (`./elysia`'s `createRequestScopePlugin`, `./hono`'s
 * `createRequestScopeMiddleware`). The scope only has to satisfy the
 * structural {@link RequestScope} contract, so wrapped/augmented containers
 * (e.g. a scope carrying extra request context) type through unchanged.
 */
import type { DisposeOptions } from '../ioc/index.ts';
import type { Logger } from '../logger/index.ts';

/** Structural contract the per-request scope must satisfy. */
export interface RequestScope {
  dispose(opts?: DisposeOptions): Promise<void>;
}

/**
 * The request context handed to `createScope` / `guard`. Structural subset of
 * a handler context — scope middleware mounts before routes, so `params` are
 * raw strings.
 */
export interface RequestScopeContext {
  request: Request;
  path: string;
  params: Record<string, string | undefined>;
}

/** `createScope` may return the scope alone, or the scope plus extra context values. */
export type CreateScopeResult<TScope extends RequestScope, TExtras extends Record<string, unknown>> =
  | TScope
  | { scope: TScope; extras: TExtras };

/**
 * Unwrap a {@link CreateScopeResult}: a wrapper carries the scope under
 * `scope` and has no dispose of its own; anything with a dispose IS the scope.
 */
export function unwrapCreateScopeResult<TScope extends RequestScope, TExtras extends Record<string, unknown>>(
  result: CreateScopeResult<TScope, TExtras>,
): { scope: TScope; extras: TExtras | undefined } {
  const wrapped = typeof (result as { dispose?: unknown }).dispose !== 'function';
  return {
    scope: wrapped ? (result as { scope: TScope }).scope : (result as TScope),
    extras: wrapped ? (result as { extras: TExtras }).extras : undefined,
  };
}

/**
 * Dispose a scope without letting a dispose failure mask the request outcome:
 * failures cannot change an already-sent response, so they are logged (or
 * dropped when no logger is given) instead of thrown.
 */
export async function disposeScopeQuietly(
  scope: RequestScope | undefined,
  opts: DisposeOptions,
  logger?: Logger,
): Promise<void> {
  if (!scope) return;
  try {
    await scope.dispose(opts);
  } catch (error) {
    logger?.error(
      `Request-scope dispose failed (commit: ${opts.commit})`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
