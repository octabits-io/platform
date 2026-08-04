/**
 * OpenAPI layer for the `./hono` glue module, on `hono-openapi` — chosen over
 * `@hono/zod-openapi` because it is *middleware*: chained routes stay chained
 * (no `OpenAPIHono`/`createRoute` DSL), `hc` inference is untouched, and the
 * vendor is confined to THIS file (boundary lint) so a failed bet swaps out as
 * one file, not a route-declaration rewrite.
 *
 * The route contract mirrors the Elysia setup 1:1: today's
 * `{ response: successResponses(200, S), detail: { summary, tags } }` becomes
 * one `describeApiRoute({ summary, tags, responses: successResponses(200, S) })`
 * middleware argument, and `octApiValidator` replaces the route `body`/`query`
 * schemas — declared once, serving runtime validation, `c.req.valid()` typing,
 * the spec's request parameters, AND the standard `validation_error` body (it
 * throws the same `RequestValidationError` as `./errors`' `octValidator`).
 *
 * House rule carried over from the probe: no `.transform()` in public route
 * schemas — zod v4's JSON-schema conversion degrades it to `{}`; declare wire
 * shapes explicitly.
 *
 * Known upstream risk (issue #216: empty `paths` on composed apps) is pinned
 * by `openapi.test.ts`, which asserts the generated spec covers every route of
 * a nested/basePath'd/middleware-wrapped composition — if an upgrade
 * reintroduces it, that gate fails, and the fallback is replacing this one
 * file with a hand-rolled route→spec registry over the same seams.
 */
import type { MiddlewareHandler, ValidationTargets } from 'hono';
import { Hono } from 'hono';
import { describeRoute, openAPIRouteHandler, resolver, validator } from 'hono-openapi';
import type { DescribeRouteOptions } from 'hono-openapi';
import type { ZodType } from 'zod';
import type { SwaggerOptions } from '../server/swagger';
import { RequestValidationError } from './errors';

const STATUS_DESCRIPTIONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** A status→schema map (the `successResponses`/`errorResponses` shape), with optional per-status description. */
export type ApiResponsesDoc = Record<number, ZodType | { description?: string; schema?: ZodType }>;

export interface ApiRouteDoc {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  /** Keep the route out of the generated spec. */
  hide?: boolean;
  /**
   * Per-status response schemas — pass the existing zod status-maps
   * (`successResponses(200, S)`, spreads of `errorResponses(...)`) verbatim.
   */
  responses?: ApiResponsesDoc;
  /**
   * OpenAPI specification extensions on the operation object, passed through
   * verbatim (e.g. `'x-openai-isConsequential': true` for ChatGPT Actions).
   */
  [extension: `x-${string}`]: unknown;
}

/**
 * Document a route for the generated spec. Returns plain middleware — mount it
 * as the first argument after the path, before validators:
 *
 * ```ts
 * .get('/',
 *   describeApiRoute({ summary: 'List contacts', tags: ['Contacts'], responses: successResponses(200, LIST) }),
 *   octApiValidator('query', SCHEMA_PAGINATION),
 *   (c) => …)
 * ```
 */
export function describeApiRoute(doc: ApiRouteDoc): MiddlewareHandler {
  const { responses, hide, ...detail } = doc;

  const documented: DescribeRouteOptions = { ...detail, hide };
  if (responses) {
    documented.responses = Object.fromEntries(
      Object.entries(responses).map(([status, entry]) => {
        const isSchema = typeof (entry as { '~standard'?: unknown })['~standard'] === 'object';
        const schema = isSchema ? (entry as ZodType) : (entry as { schema?: ZodType }).schema;
        const description =
          (!isSchema && (entry as { description?: string }).description)
          || STATUS_DESCRIPTIONS[Number(status)]
          || `Status ${status}`;
        return [status, {
          description,
          ...(schema ? { content: { 'application/json': { schema: resolver(schema) } } } : {}),
        }];
      }),
    );
  }

  return describeRoute(documented);
}

/**
 * Validating middleware for documented routes: `hono-openapi`'s `validator`
 * (so the schema is lifted into the spec's request parameters/body) with the
 * framework's error contract — failures throw {@link RequestValidationError}
 * for the global error handler instead of answering with the raw 400.
 */
export function octApiValidator<Target extends keyof ValidationTargets, S extends ZodType>(
  target: Target,
  schema: S,
) {
  return validator(target, schema, (result) => {
    if (!result.success) {
      throw new RequestValidationError(
        result.error.map((issue) => ({
          path: issue.path
            ?.map((p) => (typeof p === 'object' && p !== null && 'key' in p ? String(p.key) : String(p)))
            .join('/'),
          message: issue.message,
        })),
      );
    }
  });
}

export interface MountOpenApiOptions extends SwaggerOptions {
  /** Where the JSON spec is served. Default `'/openapi.json'`. */
  specPath?: string;
}

/**
 * Serve the generated OpenAPI 3.1 document, fed by the structural
 * `buildSwaggerOptions` output (`documentation` + `exclude` map straight
 * through). Register it on the FINISHED app — the handler walks the routes the
 * app has at call time:
 *
 * ```ts
 * const app = createHonoApp(routes, { logger });
 * mountOpenApi(app, buildSwaggerOptions({ title: 'Demo API', version: '1.0.0' }));
 * ```
 *
 * A UI stays the consumer's choice (`@hono/swagger-ui`, Scalar, or a static
 * HTML page pointing at the spec) — this package takes no UI dependency.
 *
 * Returns the SAME app type it was given, as one whole type parameter. Three
 * reasons, all load-bearing (see `./create-app`'s note for the general rule):
 * annotating it `Hono` would erase the caller's routes from any `hc` client;
 * decomposing into `<E, S, P>` would drop the nested ones; and returning
 * `app.get(specPath, …)`'s own type would be worst — `specPath` is a `string`,
 * not a literal, and Hono collapses a schema keyed by a non-literal path into
 * an index signature, taking every other route's key with it. The spec endpoint
 * is browsed, not called from a typed client, so leaving it out costs nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountOpenApi<T extends Hono<any, any, any>>(app: T, options: MountOpenApiOptions): T {
  const { specPath = '/openapi.json', documentation, exclude } = options;
  app.get(
    specPath,
    openAPIRouteHandler(app as unknown as Hono, {
      documentation,
      ...(exclude ? { exclude } : {}),
    }),
  );
  return app;
}
