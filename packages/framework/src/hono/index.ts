/**
 * SPIKE (elysia-exit-option): `src/hono` — sibling of `src/elysia` proving the
 * glue tier is replaceable. NOT exported from package.json, NOT published;
 * exists to run the existing glue test suites against a second
 * implementation. See docs/open/octabits/elysia-exit-option-hono-glue-spike.md
 * in the reynt repo.
 */
export * from './request-scope';
export * from './bearer-auth';
export * from './errors';
export * from './security-headers';
export * from './health';
export * from './create-app';
export * from './testing';
