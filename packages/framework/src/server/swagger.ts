/**
 * Swagger/OpenAPI options builder.
 *
 * Every API repeats the same `{ documentation: { info, tags }, path, exclude }`
 * literal, differing only in the title/version/tag list. This flattens that
 * nesting into one flat call.
 *
 * **Structural, no spec-generator dependency** — the return type is a plain
 * interface, so this module (and anything importing `./server`) stays free of
 * the OpenAPI plumbing. The caller keeps ownership of it:
 *
 * ```ts
 * import { mountOpenApi } from '@octabits-io/framework/hono/openapi';
 * mountOpenApi(app, buildSwaggerOptions({ title: 'My API', version: '1.2.0' }));
 * ```
 */

/** An OpenAPI tag entry. */
export interface SwaggerTag {
  name: string;
  description?: string;
}

/** The structural options document this builder emits — consumed by `./hono/openapi`'s `mountOpenApi`. */
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
 * Build the OpenAPI options object. Optional inputs are omitted from the result
 * rather than emitted as `undefined`, so the object stays a faithful minimal
 * literal.
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
