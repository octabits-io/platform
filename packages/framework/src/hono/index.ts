/**
 * `@octabits-io/framework/hono` — reusable Hono middleware & helpers, the
 * package's second HTTP glue module (sibling of `./elysia`, same confinement
 * contract: thin replaceable glue over the framework-neutral cores in
 * `../server`). See `docs/hono.md`.
 *
 * Deliberately NOT exported here (subpaths keep their optional peers out of
 * this barrel): `./hono/flow` (`@octabits-io/flow`), `./hono/mcp`
 * (`@hono/mcp` + `@modelcontextprotocol/sdk`), `./hono/events` (the events
 * sub-app wrapper).
 */
export * from './request-scope';
export * from './bearer-auth';
export * from './errors';
export * from './security-headers';
export * from './client-ip';
export * from './rate-limit';
export * from './health';
export * from './create-app';
export * from './testing';
