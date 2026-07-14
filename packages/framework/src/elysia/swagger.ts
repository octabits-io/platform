/**
 * Swagger/OpenAPI options builder.
 *
 * Every API repeats the same `swagger({ documentation: { info, tags }, path,
 * exclude })` literal, differing only in the title/version/tag list. This
 * flattens that nesting into one flat call.
 *
 * **No dependency on `@elysiajs/swagger`** — the return type is structural, so
 * this module (and anything importing the `./elysia` root) stays free of the
 * plugin. The caller keeps ownership of the plugin instance:
 *
 * ```ts
 * import { swagger } from '@elysiajs/swagger';
 * plugins.push(swagger(buildSwaggerOptions({ title: 'My API', version: '1.2.0' })));
 * ```
 */

/** An OpenAPI tag entry. */
export interface SwaggerTag {
  name: string;
  description?: string;
}

/** The structural subset of `@elysiajs/swagger`'s options this builder emits. */
export interface SwaggerOptions {
  documentation: {
    info: {
      title: string;
      version: string;
      description?: string;
    };
    tags?: SwaggerTag[];
  };
  path?: string;
  exclude?: string[];
}

export interface BuildSwaggerOptionsInput {
  /** OpenAPI `info.title`. */
  title: string;
  /** OpenAPI `info.version` — typically the package version. */
  version: string;
  /** OpenAPI `info.description`. Omitted from the output when unset. */
  description?: string;
  /** Tag definitions (name + description). Omitted from the output when unset. */
  tags?: SwaggerTag[];
  /** Where the UI is served. Default: `'/swagger'`. */
  path?: string;
  /** Route patterns to keep out of the spec (e.g. `['/auth/*']`). */
  exclude?: string[];
}

const DEFAULT_SWAGGER_PATH = '/swagger';

/**
 * Build the options object for `@elysiajs/swagger`. Optional inputs are omitted
 * from the result rather than emitted as `undefined`, so the object stays a
 * faithful minimal literal.
 *
 * ```ts
 * buildSwaggerOptions({
 *   title: 'Operator API',
 *   version: pkg.version,
 *   tags: [{ name: 'System', description: 'System endpoints' }],
 *   exclude: ['/auth/*'],
 * });
 * ```
 */
export function buildSwaggerOptions({
  title,
  version,
  description,
  tags,
  path = DEFAULT_SWAGGER_PATH,
  exclude,
}: BuildSwaggerOptionsInput): SwaggerOptions {
  return {
    documentation: {
      info: {
        title,
        version,
        ...(description !== undefined ? { description } : {}),
      },
      ...(tags !== undefined ? { tags } : {}),
    },
    path,
    ...(exclude !== undefined ? { exclude } : {}),
  };
}
