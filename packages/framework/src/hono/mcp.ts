/**
 * MCP per-request container harness — the Hono port of `../elysia/mcp`, built
 * on `@hono/mcp`'s `StreamableHTTPTransport` instead of `elysia-mcp`.
 *
 * ## What the port deletes
 *
 * The Elysia version needed ~200 LoC of workaround machinery because
 * `elysia-mcp` owns the server lifecycle: it calls `setupServer` **once
 * eagerly at plugin creation** (before any request exists) and again per
 * request, and it runs `authentication` in `onBeforeHandle` with `await`
 * points before the handler — so the resolved scope had to be carried from
 * auth to tool-invocation through an `AsyncLocalStorage` holder, `registerTools`
 * had to be idempotent, `getContainer()` was illegal during registration, and
 * an inner Elysia app served at a fixed internal path (with `parse: 'none'`
 * and hand-rolled request re-addressing) so the plugin could still nest under
 * prefixed parents.
 *
 * `@hono/mcp` hands the lifecycle back to the caller: one plain handler builds
 * a fresh `McpServer` + `StreamableHTTPTransport` **per request, after the
 * scope is resolved**. Tool closures capture that request's scope directly, so
 * every piece above is gone — no ALS, no inner app, no re-addressing, no
 * eager registration, no body-parse opt-out (the transport reads the body off
 * the Hono context itself). This is also the answer to honojs discussion
 * #4452 ("how do I reach the Hono `Context` from inside a tool?"): registering
 * tools on a module-level server puts registration before the request, and the
 * only fixes are context smuggling. Registering per request makes the question
 * disappear — `registerTools` receives an accessor that is already bound to
 * the request being served, and `resolveScope` gets the `Context` itself.
 *
 * ## Stateless
 *
 * `sessionIdGenerator: undefined` (stateless: no session ids, no cross-request
 * server state) + `enableJsonResponse: true` (a single JSON response rather
 * than an SSE stream), matching the Elysia harness. Because the response is
 * fully materialized before `handleRequest` resolves, disposing the scope in a
 * `finally` cannot cut a tool invocation short.
 *
 * ## Composition
 *
 * The factory returns a plain Hono app carrying its own `prefix`/`basePath`
 * routes, so it mounts with `parent.route(path, mcpApp)` at any depth,
 * including under param-carrying parents. `resolveScope` should read the
 * public URL from its `url` argument (equal to `c.req.url` here — unlike the
 * Elysia harness, nothing re-addresses the request).
 *
 * `@hono/mcp` and `@modelcontextprotocol/sdk` are OPTIONAL peers — only pulled
 * in by consumers of this `./mcp` subpath.
 */
import { Hono } from 'hono';
import type { Context, Env } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { DisposeOptions } from '../ioc/index.ts';
import type { Logger } from '../logger/index.ts';

/** Scope-key path segment convention: alphanumeric, hyphens, underscores. */
export const SCOPE_KEY_PATTERN = /^[a-zA-Z0-9-_]+$/;

/** Maximum accepted length of an extracted scope key. */
export const MAX_SCOPE_KEY_LENGTH = 256;

/**
 * Extracts the scope key from a request URL. Return `null` to reject the
 * request with the invalid-scope response.
 */
export type ParseScopeKey = (url: string) => string | null;

/**
 * Build a {@link ParseScopeKey} that extracts the scope key from the URL path
 * segment immediately following the **last** occurrence of `segment` — i.e. a
 * `.../{segment}/:scopeKey/...` convention. Matching the last occurrence means
 * an earlier client-controlled path component that happens to equal `segment`
 * cannot shift the extraction point. Returns `null` when `segment` is absent
 * or the following segment is missing, longer than
 * {@link MAX_SCOPE_KEY_LENGTH}, or fails {@link SCOPE_KEY_PATTERN}.
 *
 * E.g. `createPathSegmentScopeParser('scope')` for `/scope/:scopeKey/`; a
 * multi-tenant consumer passes `createPathSegmentScopeParser('tenant')` for a
 * `/tenant/:id/` URL layout.
 */
export function createPathSegmentScopeParser(segment: string): ParseScopeKey {
  return (url: string): string | null => {
    if (!segment) return null;
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }
    const segments = pathname.split('/');
    const idx = segments.lastIndexOf(segment);
    if (idx < 0) return null;
    const candidate = segments[idx + 1];
    if (!candidate || candidate.length > MAX_SCOPE_KEY_LENGTH || !SCOPE_KEY_PATTERN.test(candidate)) {
      return null;
    }
    return candidate;
  };
}

/** Build a JSON-RPC 2.0 error `Response` with the given HTTP status. */
export function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * A per-request scope/container that can release its resources.
 *
 * `dispose` receives `{ commit }` — `true` when the request produced a
 * response, `false` when it failed — so an IoC scope (`./ioc`) satisfies this
 * contract directly. A zero-arg `dispose()` is still assignable.
 */
export interface DisposableScope {
  dispose?: (opts?: DisposeOptions) => void | Promise<void>;
}

/**
 * Result of {@link CreateMcpRoutesOptions.resolveScope}: either a staged scope
 * (auth succeeded) or an early `Response` (auth rejected, e.g. `jsonRpcError`).
 */
export type ResolveScopeResult<S extends DisposableScope> =
  | { scope: S; response?: undefined }
  | { response: Response; scope?: undefined };

export interface CreateMcpRoutesOptions<S extends DisposableScope, E extends Env = Env> {
  /**
   * Auth + scope seam, run inline before the transport ever sees the request.
   * Receives the parsed `scopeKey` and the Hono `Context`; returns a staged
   * `{ scope }` (the harness disposes it after the response / on error) or an
   * early `{ response }` (e.g. `jsonRpcError(...)`) which is returned to the
   * client verbatim, status included.
   */
  resolveScope: (args: {
    scopeKey: string;
    /**
     * The public request URL. Identical to `context.req.url` on Hono (kept for
     * signature parity with the Elysia harness, where the request was
     * re-addressed to an internal path before reaching the MCP app).
     */
    url: string;
    context: Context<E>;
  }) => Promise<ResolveScopeResult<S>>;
  /**
   * Register the domain tools/resources on an `McpServer`.
   *
   * Called **once per request**, on a fresh server, after `resolveScope` has
   * succeeded — so `getContainer()` is valid immediately, both during
   * registration and inside tool handlers, and always returns this request's
   * scope. (The Elysia harness additionally ran this at startup with no
   * container available; that constraint is gone.)
   */
  registerTools: (server: McpServer, getContainer: () => S) => void | Promise<void>;
  /** MCP server identity advertised to clients. */
  serverInfo: { name: string; version: string };
  /**
   * Extracts the scope key from the request URL; return `null` to reject.
   * Required — there is deliberately no default URL convention. Use
   * `createPathSegmentScopeParser('scope')` for a `/scope/:scopeKey/` layout,
   * `createPathSegmentScopeParser('tenant')` for a `/tenant/:id/` layout
   * (consumer vocabulary, their choice), or `() => 'default'` for single-scope
   * deployments.
   */
  parseScopeKey: ParseScopeKey;
  /** Route prefix inside the returned app. Default `/mcp`. */
  prefix?: string;
  /** Base path within the prefix. Default `/`. */
  basePath?: string;
  /** MCP capabilities advertised to clients. Default `{ tools: {} }`. */
  capabilities?: ServerCapabilities;
  /** Response returned when `parseScopeKey` yields no scope key. Default `jsonRpcError(400, -32600, 'Invalid scope key')`. */
  invalidScopeResponse?: () => Response;
  /** Diagnostics (e.g. a scope `dispose()` failure after the response). */
  logger?: Logger;
}

/**
 * Build the MCP endpoint: a per-request `McpServer` on `@hono/mcp`'s
 * stateless `StreamableHTTPTransport`, with the scope resolved before the
 * transport runs and disposed in a `finally` tied to the request.
 *
 * ```ts
 * const mcp = createMcpRoutes<MyScope>({
 *   parseScopeKey: createPathSegmentScopeParser('scope'),
 *   resolveScope: async ({ scopeKey }) => ({ scope: container.createScope(scopeKey) }),
 *   registerTools: (server, getScope) => {
 *     server.registerTool('whoami', {}, async () => ({
 *       content: [{ type: 'text', text: getScope().id }],
 *     }));
 *   },
 *   serverInfo: { name: 'my-server', version: '1.0.0' },
 * });
 * app.route('/api/scope/:scopeKey', mcp); // → POST /api/scope/:scopeKey/mcp
 * ```
 */
export const createMcpRoutes = <S extends DisposableScope, E extends Env = Env>(
  options: CreateMcpRoutesOptions<S, E>,
): Hono<E> => {
  const {
    resolveScope,
    registerTools,
    serverInfo,
    parseScopeKey,
    prefix = '/mcp',
    basePath = '/',
    capabilities = { tools: {} },
    invalidScopeResponse = () => jsonRpcError(400, -32600, 'Invalid scope key'),
    logger,
  } = options;

  const disposeQuietly = async (scope: S, commit: boolean): Promise<void> => {
    try {
      await scope.dispose?.({ commit });
    } catch (error) {
      logger?.error(
        'Failed to dispose MCP scope container',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  const handle = async (c: Context<E>): Promise<Response> => {
    const url = c.req.url;
    const scopeKey = parseScopeKey(url);
    if (!scopeKey) return invalidScopeResponse();

    const resolved = await resolveScope({ scopeKey, url, context: c });
    if (resolved.response) return resolved.response;
    const scope = resolved.scope;

    // Fresh server + transport per request: stateless, no cross-request state,
    // and tool handlers close over THIS request's scope.
    const server = new McpServer(serverInfo, { capabilities });
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    let committed = false;
    try {
      await registerTools(server, () => scope);
      await server.connect(transport);
      // `enableJsonResponse` means this settles only once the JSON-RPC
      // response body exists — every tool handler has finished.
      const response = await transport.handleRequest(c);
      committed = true;
      // Unreachable in practice: every branch of the transport returns a
      // response or throws an HTTPException. Fail closed rather than crash.
      return response ?? jsonRpcError(500, -32603, 'Internal error');
    } finally {
      // Releases the transport's per-request stream bookkeeping. A close
      // failure must not mask the response (or the error on its way out).
      await server.close().catch(() => {});
      await disposeQuietly(scope, committed);
    }
  };

  // `${prefix}${basePath}` plus its wildcard subtree, mirroring the Elysia
  // harness's two routes: `/mcp/*` does not match a bare `/mcp`.
  const base = `${prefix}${basePath === '/' ? '' : basePath}` || '/';
  const wildcard = base === '/' ? '/*' : `${base}/*`;

  const app = new Hono<E>();
  app.all(base, handle);
  app.all(wildcard, handle);
  return app;
};
