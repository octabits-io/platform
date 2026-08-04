/**
 * Re-export of the framework's keyed-error → JSON-response helpers. This file
 * existed as an app-local implementation while `./hono` didn't export one; the
 * helpers were promoted upstream (same semantics: `errorJson(c, error)`
 * returns the response so error shapes stay in the route type for `hc`, and
 * `createErrorJson(overrides)` binds a domain's key→status rules).
 */
export { createErrorJson, errorJson } from '@octabits-io/framework/hono';
