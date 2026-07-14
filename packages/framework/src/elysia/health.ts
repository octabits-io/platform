/**
 * Health-check route harness (#13): the `/health` liveness alias + `/live` +
 * `/ready` trio every API duplicates, plus the `onError` that maps `/ready`
 * failures to a `503`.
 *
 * The readiness probe is generalized as an injected `checkReady: () => Promise<void>`
 * callback (e.g. a `SELECT 1`-via-Drizzle closure) — no db/container
 * coupling in the package. Response bodies: `{ status: 'ok' }` for liveness,
 * `{ status: 'ok', db: 'connected' }` for readiness, `{ status: 'error',
 * message }` for the 503.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import type { Logger } from '../logger/index.ts';

/** Liveness response — `{ status: 'ok' }`. */
export const SCHEMA_HEALTH_LIVE_RESPONSE = z.object({
  status: z.literal('ok').describe('Liveness status'),
});

/** Readiness response — `{ status: 'ok', db: 'connected' }`. */
export const SCHEMA_HEALTH_READY_RESPONSE = z.object({
  status: z.literal('ok').describe('Readiness status'),
  db: z.literal('connected').describe('Database connection status'),
});

export interface CreateHealthRoutesOptions {
  /**
   * Readiness probe. Resolve if the API can serve requests; reject/throw to
   * signal not-ready (→ `503`). E.g. a `SELECT 1`-via-Drizzle closure.
   */
  checkReady: () => Promise<void>;
  /** Logger for readiness failures. Optional — pass an already-childed logger. */
  logger?: Logger;
  /** Route prefix. Default `/health`. */
  prefix?: string;
  /** Swagger tags applied to every route. Default `['System']`. */
  tags?: string[];
  /** Body message on a `/ready` failure. Default `'Database unavailable'`. */
  readyErrorMessage?: string;
}

/**
 * Health check endpoints for load balancers and monitoring.
 *
 * - `GET {prefix}`       - Backward compatible alias to `{prefix}/live`
 * - `GET {prefix}/live`  - Liveness probe (is the process alive?)
 * - `GET {prefix}/ready` - Readiness probe (can it serve requests? runs `checkReady`)
 *
 * `/ready` failures are caught by an `onError` that returns a `503` with
 * `{ status: 'error', message }` — all other errors are rethrown.
 */
export const createHealthRoutes = (options: CreateHealthRoutesOptions) => {
  const {
    checkReady,
    logger,
    prefix = '/health',
    tags = ['System'],
    readyErrorMessage = 'Database unavailable',
  } = options;

  // NOTE: the `onError` mapper is registered BEFORE the routes so it reliably
  // applies to them — Elysia only wires a local error hook to routes defined
  // after it. It maps `/ready` failures to a 503 and rethrows everything else.
  return new Elysia({ prefix })
    .onError(({ error, request }) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/ready')) {
        logger?.error('Readiness check failed', error instanceof Error ? error : new Error(String(error)));
        return new Response(
          JSON.stringify({ status: 'error', message: readyErrorMessage }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw error;
    })
    .get(
      '/',
      () => ({ status: 'ok' as const }),
      {
        response: SCHEMA_HEALTH_LIVE_RESPONSE,
        detail: {
          summary: 'Health check (alias)',
          description: 'Backward compatible health check. Alias for /health/live.',
          tags,
        },
      },
    )
    .get(
      '/live',
      () => ({ status: 'ok' as const }),
      {
        response: SCHEMA_HEALTH_LIVE_RESPONSE,
        detail: {
          summary: 'Liveness probe',
          description: 'Returns OK if the API process is running. Use for Kubernetes liveness probes.',
          tags,
        },
      },
    )
    .get(
      '/ready',
      async () => {
        await checkReady();
        return { status: 'ok' as const, db: 'connected' as const };
      },
      {
        response: SCHEMA_HEALTH_READY_RESPONSE,
        detail: {
          summary: 'Readiness probe',
          description:
            'Returns OK if the API is ready to serve requests. Checks database connectivity. Use for Kubernetes readiness probes.',
          tags,
        },
      },
    );
};
