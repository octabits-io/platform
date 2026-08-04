/**
 * `Bun.serve` adapter satisfying `…/server`'s structural `ListenableApp`.
 *
 * `runServer` only requires `.listen(port)` — that contract never mentioned
 * Elysia, and it is exactly why the run/shutdown tail survived the framework
 * swap untouched. Hono, though, is a *handler*, not a server: it exposes
 * `fetch` and leaves listening to the runtime. This ten-line adapter is the
 * whole difference.
 *
 * It stays app-local on purpose. A framework version would have to pick a
 * runtime (`Bun.serve` / `@hono/node-server` / Deno / workers), and picking one
 * is precisely the decision a consumer owns — `…/hono` deliberately ships no
 * runtime dependency. The demo runs on Bun, so this is `Bun.serve`.
 *
 * `maxRequestBodySize` is set explicitly: it was `createElysiaApp`'s
 * `serve.maxRequestBodySize` option before, and Bun's default (128 MB) is two
 * orders of magnitude looser than the 10 MB this API wants for its uploads.
 */
import type { Hono } from 'hono';
import type { Env, Schema } from 'hono';

export interface BunServerOptions {
  /** Request-body cap in bytes, mapped to `Bun.serve`'s `maxRequestBodySize`. */
  maxRequestBodySize?: number;
}

/** A Hono app wrapped in the `.listen(port)` / `.stop()` shape `runServer` drives. */
export interface ListenableHonoApp {
  listen(port: number | string): void;
  stop(): Promise<void>;
}

export function createBunServer<E extends Env, S extends Schema, P extends string>(
  app: Hono<E, S, P>,
  options: BunServerOptions = {},
): ListenableHonoApp {
  let server: ReturnType<typeof Bun.serve> | undefined;

  return {
    listen(port) {
      server = Bun.serve({
        port: Number(port),
        fetch: (request, bunServer) => app.fetch(request, { bunServer }),
        ...(options.maxRequestBodySize !== undefined
          ? { maxRequestBodySize: options.maxRequestBodySize }
          : {}),
      });
    },
    async stop() {
      // `true` closes in-flight connections too — the graceful-shutdown
      // watchdog in `registerGracefulShutdown` is what bounds the wait, and a
      // held-open SSE stream would otherwise outlive it.
      await server?.stop(true);
    },
  };
}
