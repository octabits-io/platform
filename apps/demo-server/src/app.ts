/**
 * App composition + the `App` type Eden Treaty consumes.
 *
 * `createElysiaApp` mounts the standard pipeline in a fixed order —
 * `securityHeaders → clientIp → rateLimit → [caller plugins] → errorHandler →
 * routes` — and returns the composed instance with the *routes' type intact*,
 * which is what makes `export type App = ReturnType<typeof createDemoApp>` work
 * for Eden.
 *
 * Ordering that matters and is easy to get wrong: the client-IP plugin must be
 * mounted before the rate limiter, or every request keys into one shared
 * `'unknown'` bucket and the limiter throttles all traffic collectively. Passing
 * `clientIp` to `createElysiaApp` guarantees the order.
 *
 * `cors` is wired through that same `plugins` seam: the framework takes plugins
 * as ready-built instances precisely so it needn't depend on `@elysiajs/*`.
 * (`swagger` would mount the same way.) CORS is not optional here — the demo
 * SPA is served from a different origin than this API, so without it every
 * browser request fails preflight while curl sails through unaffected.
 */
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { createElysiaApp, createHealthRoutes } from '@octabits-io/framework/elysia';
import type { IoC } from '@octabits-io/framework/ioc';
import type { AppConfig } from './config.ts';
import type { DemoServices } from './container.ts';
import { createContactRoutes } from './routes/contacts.ts';
import { createNoteRoutes } from './routes/notes.ts';
import { createFileRoutes } from './routes/files.ts';
import { createSettingsRoutes } from './routes/settings.ts';
import { createQueueRoutes } from './routes/queue.ts';
import { createToolRoutes } from './routes/tools.ts';

export interface CreateDemoAppDeps {
  container: IoC<DemoServices>;
  config: AppConfig;
  /** Readiness probe — resolves when the app can serve traffic. */
  checkReady: () =>  Promise<void>;
}

/** Every `/api/*` route. Exported separately so the type stays inspectable. */
export function createApiRoutes(container: IoC<DemoServices>) {
  return new Elysia({ prefix: '/api' })
    .use(createContactRoutes(container))
    .use(createNoteRoutes(container))
    .use(createFileRoutes(container))
    .use(createSettingsRoutes(container))
    .use(createQueueRoutes(container))
    .use(createToolRoutes(container));
}

export function createDemoApp({ container, config, checkReady }: CreateDemoAppDeps) {
  const logger = container.resolve('logger');

  const routes = new Elysia()
    .use(createHealthRoutes({ checkReady, logger: logger.child({ component: 'health' }) }))
    .use(createApiRoutes(container));

  return createElysiaApp(routes, {
    logger,
    plugins: [
      cors({
        origin: config.corsOrigins,
        // `x-demo-role` is this demo's stand-in for a JWT role claim; without
        // it in the allow-list the preflight rejects every non-GET call.
        allowedHeaders: ['content-type', 'authorization', 'x-demo-role'],
        // ETag drives the blob 304s in `routes/files.ts`; a cross-origin
        // reader cannot see it unless it is explicitly exposed.
        exposeHeaders: ['etag', 'content-disposition'],
      }),
    ],
    clientIp: config.trustedProxies,
    rateLimit: { max: config.rateLimit.max, windowMs: config.rateLimit.windowMs, logger },
    maxRequestBodySize: 10 * 1024 * 1024,
  });
}

/** The type Eden Treaty is generated against. */
export type App = ReturnType<typeof createDemoApp>;
