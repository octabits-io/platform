// ============================================================================
// @octabits-io/framework/server — framework-agnostic server toolkit
// ============================================================================
//
// The parts of running an HTTP API that have nothing to do with the HTTP
// framework: typed env-config accessors, the `main()` run/shutdown tail
// (structural `.listen(port)` contract), the Swagger/OpenAPI options builder
// (structural, no `@elysiajs/swagger` dependency), and the standard zod
// response schemas. Nothing in this module imports Elysia — that is enforced
// by `scripts/check-boundaries.mjs` (base tier).
//
// Everything here is also re-exported from `./elysia` for backwards
// compatibility; new code should import it from `@octabits-io/framework/server`.

export * from './config';
export * from './responses';
export * from './swagger';
export * from './run';
export * from './errors';
export * from './request-scope';
export * from './bearer-auth';
export * from './security-headers';
export * from './client-ip';
export * from './rate-limit';

// NOTE: the request-test harness lives at the `./server/testing` subpath, not
// re-exported here: test helpers should not be reachable from production route
// code. Import it via `@octabits-io/framework/server/testing`.
