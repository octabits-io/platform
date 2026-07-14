/**
 * Test-harness helpers for driving an Elysia app through `app.handle()` — no
 * port binding, no HTTP stack, just Request in / Response out.
 *
 * A **separate subpath** (`@octabits-io/framework/elysia/testing`), deliberately
 * not re-exported from the `./elysia` root: test helpers have no business being
 * reachable from production route code. The module is also **test-runner
 * agnostic** — plain functions, no vitest import — so it works under any runner.
 *
 * ```ts
 * import { testRequest } from '@octabits-io/framework/elysia/testing';
 *
 * const res = await testRequest(app, 'GET', '/items', { query: { limit: 10 } });
 * expect(res.status).toBe(200);
 * expect((res.data as { items: unknown[] }).items).toHaveLength(1);
 * ```
 */

/** Structural contract for the app under test — satisfied by an Elysia instance. */
export interface TestableApp {
  handle(request: Request): Promise<Response>;
}

export interface TestRequestOptions {
  /** JSON-serialized into the request body. Omit for bodiless requests. */
  body?: unknown;
  /**
   * Extra request headers. Merged case-insensitively over the defaults, so
   * passing `content-type` (any casing) replaces the default rather than
   * producing a doubled header value.
   */
  headers?: Record<string, string>;
  /** Appended as a query string. `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Shorthand for `Authorization: Bearer <token>`. An explicit `authorization`
   * header in `headers` wins.
   */
  token?: string;
  /**
   * Override response-body decoding. Use it for content types the default
   * doesn't know, or to assert on the raw `Response`.
   */
  decodeBody?: (res: Response) => Promise<unknown>;
}

export interface TestResponse {
  status: number;
  /** The decoded body — see {@link decodeResponseBody}. */
  data: unknown;
  headers: Headers;
}

/** Statuses that carry no body worth decoding (reading it would just yield `''`). */
const BODILESS_STATUSES = new Set([204, 301, 302]);

/**
 * Default body decoding:
 * - `204` / `301` / `302` → `null` (no body; redirects are asserted via `headers`)
 * - `application/json` → parsed JSON
 * - `application/pdf` / `application/octet-stream` → `Buffer` (byte-exact;
 *   `.text()` would mangle binary through UTF-8 decoding)
 * - anything else → `text()`
 *
 * Exported so a custom `decodeBody` can delegate to it for the cases it doesn't
 * special-case.
 */
export async function decodeResponseBody(res: Response): Promise<unknown> {
  if (BODILESS_STATUSES.has(res.status)) return null;

  const contentType = res.headers.get('content-type');
  if (contentType?.includes('application/json')) return res.json();
  if (contentType?.includes('application/pdf') || contentType?.includes('application/octet-stream')) {
    return Buffer.from(await res.arrayBuffer());
  }
  return res.text();
}

function buildUrl(path: string, query: TestRequestOptions['query']): string {
  const url = new URL(path, 'http://localhost');
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Drive one request through `app.handle()` and return `{ status, data, headers }`.
 *
 * `Content-Type: application/json` is sent by default (override via `headers`).
 *
 * ```ts
 * await testRequest(app, 'POST', '/items', { body: { name: 'x' }, token: 'abc' });
 * ```
 */
export async function testRequest(
  app: TestableApp,
  method: string,
  path: string,
  options: TestRequestOptions = {},
): Promise<TestResponse> {
  const { body, headers: extraHeaders, query, token, decodeBody = decodeResponseBody } = options;

  // A Headers instance (not a plain record) so caller-supplied header names
  // overwrite the defaults case-insensitively instead of being appended.
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value);
  }
  if (token !== undefined && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await app.handle(new Request(buildUrl(path, query), init));

  return {
    status: response.status,
    data: await decodeBody(response),
    headers: response.headers,
  };
}

/**
 * {@link testRequest} with an explicit `Authorization` header value.
 *
 * `authHeader` is the **full** header value (scheme included), matching the
 * shape this replaces:
 *
 * ```ts
 * await testAuthenticatedRequest(app, 'POST', '/items', { body }, 'Bearer test-token');
 * ```
 *
 * Prefer `testRequest(app, method, path, { token })` for the plain-bearer case.
 */
export async function testAuthenticatedRequest(
  app: TestableApp,
  method: string,
  path: string,
  options: TestRequestOptions = {},
  authHeader: string,
): Promise<TestResponse> {
  return testRequest(app, method, path, {
    ...options,
    headers: { ...options.headers, Authorization: authHeader },
  });
}
