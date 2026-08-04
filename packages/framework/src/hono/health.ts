/**
 * SPIKE (elysia-exit-option): Hono port of `../elysia/health`.
 *
 * Same trio (`/` alias, `/live`, `/ready`) and the same bodies. Two
 * simplifications over the Elysia version:
 *
 * - No `prefix` option: the caller mounts the sub-app where it wants it
 *   (`app.route('/health', createHealthApp(...))`).
 * - No `onError` ordering ritual: the `/ready` failure → 503 mapping is a
 *   plain try/catch in the handler. (Also sidesteps the Hono gotcha that a
 *   sub-app's `onError` must be registered before `route()` copies handlers.)
 *
 * The zod response schemas are shared from the Elysia module — they document
 * the contract; Hono does not validate responses (see spike findings on
 * swagger/OpenAPI, which is a separate `@hono/zod-openapi` opt-in).
 */
import { Hono } from 'hono';
import type { Logger } from '../logger/index.ts';

export { SCHEMA_HEALTH_LIVE_RESPONSE, SCHEMA_HEALTH_READY_RESPONSE } from '../elysia/health';

export interface CreateHealthAppOptions {
  /**
   * Readiness probe. Resolve if the API can serve requests; reject/throw to
   * signal not-ready (→ `503`). E.g. a `SELECT 1`-via-Drizzle closure.
   */
  checkReady: () => Promise<void>;
  /** Logger for readiness failures. Optional — pass an already-childed logger. */
  logger?: Logger;
  /** Body message on a `/ready` failure. Default `'Database unavailable'`. */
  readyErrorMessage?: string;
}

/**
 * Health check endpoints for load balancers and monitoring. Mount with
 * `app.route('/health', createHealthApp({ checkReady }))`:
 *
 * - `GET /`      - Backward compatible alias to `/live`
 * - `GET /live`  - Liveness probe (is the process alive?)
 * - `GET /ready` - Readiness probe (can it serve requests? runs `checkReady`)
 */
export function createHealthApp(options: CreateHealthAppOptions): Hono {
  const { checkReady, logger, readyErrorMessage = 'Database unavailable' } = options;

  return new Hono()
    .get('/', (c) => c.json({ status: 'ok' as const }))
    .get('/live', (c) => c.json({ status: 'ok' as const }))
    .get('/ready', async (c) => {
      try {
        await checkReady();
      } catch (error) {
        logger?.error('Readiness check failed', error instanceof Error ? error : new Error(String(error)));
        return c.json({ status: 'error' as const, message: readyErrorMessage }, 503);
      }
      return c.json({ status: 'ok' as const, db: 'connected' as const });
    });
}
