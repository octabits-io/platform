/**
 * Backwards-compatible re-export: the test harness moved to
 * `@octabits-io/framework/server/testing` — it never depended on Elysia (the
 * app contract is the structural `{ handle(Request): Promise<Response> }`).
 * Import it from there in new code.
 */
export * from '../server/testing';
