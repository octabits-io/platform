# @octabits-io/framework/server

The framework-agnostic server toolkit: the parts of running an HTTP API that
have nothing to do with the HTTP framework. Nothing here imports an HTTP
framework — the app is only ever a structural contract (`.listen(port)` for
`runServer`, `handle(Request)` for the test helpers), so any HTTP framework or
plain fetch handler satisfies it. [`./hono`](./hono.md) wires these cores into
Hono's hooks; this module is where the logic actually lives, and it survived the
Elysia→Hono swap untouched.

## Contents

- **Env-config helpers** — `getEnv`, `getEnvOptional`, `getEnvNumber`,
  `getEnvNumberOptional`, `getEnvBoolean`, `isProduction`, `parseCsv`,
  `parseCorsOrigins`, and **`assertNotInProduction(name, value?)`** — fails
  startup when a dev-only escape hatch (auth bypass, seed endpoint, debug route)
  is set in production. Omit `value` to read `process.env[name]`. Any non-empty
  string counts as set (including `'false'` — these are presence-flags).
- **`runServer({ load, logger?, exitProcess?, shutdown? })`** — the `main()`
  tail: `await load()` → `app.listen(port)` → started-log →
  `registerGracefulShutdown`. Everything that can fail during bootstrap lives in
  the caller's `load()`, so a throw there is uniformly logged as
  `'Failed to start server'` + `process.exit(1)` instead of becoming an
  unhandled rejection. `load()` returns `{ app, port, logger?, stop?, onStarted? }`
  — `logger` is returned (not passed) because the app logger usually only exists
  once the container is up; it falls back to the bootstrap `logger`. Runtime- and
  framework-agnostic (the app only needs the structural `.listen(port)`) and
  **importing the module boots nothing**. `exitProcess: false` rethrows instead
  of exiting, for tests and embedders.
- **`registerGracefulShutdown({ logger, stop, signals?, timeoutMs? })`** — wires
  SIGTERM/SIGINT to an async teardown bounded by `timeoutMs` (default 10s;
  force-exit 1 on hang, exit 1 on a rejected `stop`, exit 0 on success).
- **`buildSwaggerOptions({ title, version, description?, tags?, path?, exclude? })`**
  — flattens the repeated OpenAPI options literal. Returns a plain
  structurally-typed object with **no spec-generator dependency**; the caller
  serves it (`mountOpenApi(app, buildSwaggerOptions({ … }))` from
  [`./hono/openapi`](./hono.md)). `path` defaults to `/swagger`; unset optionals
  are omitted rather than emitted as `undefined`.
- **Response schemas** (zod) — `SCHEMA_ERROR_RESPONSE`, `SCHEMA_VALIDATION_ERROR`,
  `SCHEMA_SUCCESS_RESPONSE`, the `CommonErrorResponses` superset, and the
  `errorResponses(...codes)` selector.
- **`successResponses(status, schema)`** — `{ [status]: schema, 200: schema }`.
  Originally an Eden Treaty workaround (Elysia inferred a phantom 200 out of the
  handler's return union, which Eden then folded error bodies into). Hono's `hc`
  declares no such phantom status, so non-200-success routes narrow on their
  own and the helper is now **documentation**: it feeds the OpenAPI document a
  complete response map. Pass it to `describeApiRoute`/`octApiValidator`:
  `responses: { ...successResponses(201, Created), ...errorResponses(400, 409) }`.
- **`@octabits-io/framework/server/testing`** — `testRequest(app, method, path, { body?, headers?, query?, token?, decodeBody? })`
  and `testAuthenticatedRequest(app, method, path, options, authHeader)`: drive
  an app through its `handle(Request)` — no port binding — returning
  `{ status, data, headers }`. The app contract is the structural `TestableApp`
  (`{ handle(Request): Promise<Response> }`), satisfied by a Hono instance or
  any fetch-style handler. Default decoding: `204`/`301`/`302` → `null`,
  JSON → parsed, `application/pdf`/`application/octet-stream` → `Buffer`
  (byte-exact), else `text()`; override via `decodeBody` (which can delegate to
  the exported `decodeResponseBody`). Headers merge case-insensitively over the
  default `content-type: application/json`. A separate subpath, deliberately not
  re-exported from the `./server` root (test helpers should not be reachable
  from production route code), and test-runner agnostic — no vitest import.

## Usage

```ts
import { getEnv, runServer, buildSwaggerOptions } from '@octabits-io/framework/server';

await runServer({
  logger: bootstrapLogger,
  load: async () => {
    const config = loadConfig();               // getEnv(...) inside
    const container = await initializeContainer(config);
    return {
      app: createApp(container),               // anything with .listen(port)
      port: config.port,
      logger: container.resolve('logger'),
      stop: async () => container.dispose(),
    };
  },
});
```

Peer dependencies: `zod` only. No HTTP framework.
