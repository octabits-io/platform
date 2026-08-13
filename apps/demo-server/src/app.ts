/**
 * App composition + the `App` type the typed client (`hc`) consumes.
 *
 * `createHonoApp` mounts the standard pipeline in a fixed order —
 * `securityHeaders → [caller middleware] → errorHandler → routes` — and
 * returns the composed instance **with the routes' type intact**, which is
 * what makes `export type App = ReturnType<typeof createDemoApp>` work for
 * `hc`. (That preservation is load-bearing and easy to lose: annotating a
 * composed app as `Hono` erases every route from the client type while the
 * server keeps working. The framework pins it with a test.)
 *
 * Ordering that matters and is easy to get wrong: the client-IP middleware
 * must be mounted before the rate limiter, or every request keys into one
 * shared `'unknown'` bucket and the limiter throttles all traffic
 * collectively. Unlike `createElysiaApp`, `createHonoApp` has no `clientIp`
 * option to guarantee that for you — on Hono the pipeline IS the `middleware`
 * array, so the order is the caller's to get right (the limiter logs a warning
 * once if `clientIp` is missing).
 *
 * `cors` is Hono's own `hono/cors` — no `@elysiajs/cors` equivalent needed,
 * and no plugins seam: middleware is middleware. CORS is not optional here —
 * the demo SPA is served from a different origin than this API, so without it
 * every browser request fails preflight while curl sails through unaffected.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import { buildSwaggerOptions } from '@octabits-io/framework/server';
import {
  createClientIpMiddleware,
  createHealthApp,
  createHonoApp,
  createRateLimitMiddleware,
  createSecurityHeadersMiddleware,
} from '@octabits-io/framework/hono';
import { mountOpenApi } from '@octabits-io/framework/hono/openapi';
import type { MiddlewareHandler } from 'hono';
import type { IoC } from '@octabits-io/framework/ioc';
import type { AppConfig } from './config.ts';
import type { DemoServices } from './container.ts';
import { createContactRoutes } from './routes/contacts.ts';
import { createAiRoutes, type AiRoutesDeps } from './routes/ai.ts';
import { createNoteRoutes } from './routes/notes.ts';
import { createFileRoutes } from './routes/files.ts';
import { createSettingsRoutes } from './routes/settings.ts';
import { createQueueRoutes } from './routes/queue.ts';
import { createToolRoutes } from './routes/tools.ts';
import { createDemoScopeMiddleware, type DemoScopeMiddleware } from './request-scope.ts';
import { createDemoApiKeys, type DemoApiKeys } from './api-keys.ts';
import { createProtectedRoutes } from './routes/protected.ts';
import { createEventRoutes, createEventStreamMount } from './routes/events.ts';

/** Where the OpenAPI JSON and the browsable UI are served. */
const SPEC_PATH = '/openapi.json';
const DOCS_PATH = '/swagger';
/** Where `@hono/swagger-ui`'s generated page fetches swagger-ui-dist from. */
const SWAGGER_CDN = 'https://cdn.jsdelivr.net';

export interface CreateDemoAppDeps {
  container: IoC<DemoServices>;
  /** Injectable for tests (issue a key, assert against it). Default: fresh set with a logged bootstrap key. */
  apiKeys?: DemoApiKeys;
  config: AppConfig;
  /** The flow engine + usage services behind `/api/ai` (built in main.ts / tests). */
  ai: AiRoutesDeps;
  /** Readiness probe — resolves when the app can serve traffic. */
  checkReady: () => Promise<void>;
}

/** Every `/api/*` route. Exported separately so the type stays inspectable. */
export function createApiRoutes(
  container: IoC<DemoServices>,
  scopeMiddleware: DemoScopeMiddleware,
  apiKeys: DemoApiKeys,
  ai: AiRoutesDeps,
) {
  // Two resolution styles, on purpose (both are documentation):
  // contacts + settings go through the per-request scope (`c.get('scope')`)
  // because the request seeds state they need (role, the per-request settings
  // cache); notes/files/queue/tools resolve stateless singletons off the root.
  //
  // ONE chain: Hono only accumulates route types across chained calls, and the
  // accumulated type is what `hc` reads. A `const app = new Hono(); app.route(…)`
  // sequence serves identically and types as nothing.
  return new Hono()
    .route('/contacts', createContactRoutes(scopeMiddleware))
    .route('/notes', createNoteRoutes(container))
    .route('/files', createFileRoutes(container))
    .route('/settings', createSettingsRoutes(scopeMiddleware))
    .route('/queue', createQueueRoutes(container))
    .route('/', createToolRoutes(container))
    .route('/protected', createProtectedRoutes(apiKeys))
    .route('/ai', createAiRoutes(ai))
    .route('/events', createEventRoutes(container));
}

/**
 * Hardening headers, with the docs page carved out.
 *
 * The API's default CSP is `default-src 'none'` — correct for a JSON API and
 * fatal for a Swagger page, which needs its own script/style/font/image
 * sources. The security-headers middleware sets its map on `c.res` *after*
 * `next()`, so it always wins over anything a route set: relaxing the policy
 * for one path means picking the header set at the top, not overriding it
 * further down. Two pre-built instances behind a path test is the whole trick,
 * and the API stays hardened byte-for-byte.
 */
function createSecurityHeaders(): MiddlewareHandler {
  const api = createSecurityHeadersMiddleware();
  const docs = createSecurityHeadersMiddleware({
    csp: [
      "default-src 'self'",
      // `@hono/swagger-ui` renders a page that pulls swagger-ui-dist from
      // **cdn.jsdelivr.net** (not unpkg — verified in a browser, because a CSP
      // violation is invisible to curl) and boots it from an inline script.
      `script-src 'self' 'unsafe-inline' ${SWAGGER_CDN}`,
      `style-src 'self' 'unsafe-inline' ${SWAGGER_CDN}`,
      `img-src 'self' data: ${SWAGGER_CDN}`,
      "font-src 'self' data:",
      // "Try it out" calls this same API.
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  });

  return (c, next) => (c.req.path.startsWith(DOCS_PATH) ? docs(c, next) : api(c, next));
}

export function createDemoApp({ container, config, checkReady, ai, ...deps }: CreateDemoAppDeps) {
  const logger = container.resolve('logger');
  const scopeMiddleware = createDemoScopeMiddleware(container, logger.child({ component: 'request-scope' }));
  const apiKeys = deps.apiKeys ?? createDemoApiKeys(logger.child({ component: 'api-keys' }));

  const routes = new Hono()
    .route('/health', createHealthApp({ checkReady, logger: logger.child({ component: 'health' }) }))
    .route('/api', createApiRoutes(container, scopeMiddleware, apiKeys, ai));

  const app = createHonoApp(routes, {
    logger,
    securityHeaders: false,
    middleware: [
      createSecurityHeaders(),
      createClientIpMiddleware({ trustedProxies: config.trustedProxies }),
      createRateLimitMiddleware({
        max: config.rateLimit.max,
        windowMs: config.rateLimit.windowMs,
        logger,
        // The SSE stream holds one connection open for its whole life; counting
        // it against a per-minute request budget would throttle reconnects.
        skipPaths: ['/api/events/stream'],
      }),
      cors({
        origin: config.corsOrigins,
        // `x-demo-role` is this demo's stand-in for a JWT role claim; without
        // it in the allow-list the preflight rejects every non-GET call.
        allowHeaders: ['content-type', 'authorization', 'x-demo-role'],
        // ETag drives the blob 304s in `routes/files.ts`; a cross-origin
        // reader cannot see it unless it is explicitly exposed.
        exposeHeaders: ['etag', 'content-disposition'],
      }),
    ],
  });

  // The SSE stream goes through `.mount()` — a plain fetch handler, no route-type
  // budget, no client types, and (crucially on Hono) outside the request-scope
  // middleware, which disposes before the Response is returned. See routes/events.ts.
  app.mount('/api/events/stream', createEventStreamMount(container));

  if (config.enableSwagger) {
    // Registered on the FINISHED app: the spec handler walks the routes the app
    // has at call time. `buildSwaggerOptions` is the same structural options
    // object the Elysia build fed `@elysiajs/swagger`.
    mountOpenApi(app, {
      ...buildSwaggerOptions({
        title: 'Contact Desk API',
        version: '0.0.0',
        description: 'Demo API exercising @octabits-io/framework end to end.',
        path: DOCS_PATH,
        tags: [
          { name: 'Contacts', description: 'PII-encrypted contacts with blind-index search' },
          { name: 'Notes', description: 'Plain CRUD via createBaseCrudService' },
          { name: 'Files', description: 'Postgres blob storage' },
          { name: 'Settings', description: 'Scoped config engine' },
          { name: 'Queue', description: 'pg-boss monitoring' },
          { name: 'Tools', description: 'Captcha, slugify' },
          { name: 'Protected', description: 'API-key bearer auth' },
          { name: 'AI', description: 'Durable AI workflows (octaflow)' },
          { name: 'Events', description: 'Two-lane event fan-out' },
        ],
      }),
      specPath: SPEC_PATH,
    });
    // The framework takes no UI dependency on purpose — the page is the
    // consumer's choice. `@hono/swagger-ui` is the lightest one that exists.
    app.get(DOCS_PATH, swaggerUI({ url: SPEC_PATH }));
  }

  return app;
}

/** The type the typed client (`hc`) is generated against. */
export type App = ReturnType<typeof createDemoApp>;
