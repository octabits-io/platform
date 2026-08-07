/**
 * Standard HTTP response schemas for route response maps (`./hono/openapi`'s
 * `describeApiRoute`/`octApiValidator` take them verbatim), plus the
 * `CommonErrorResponses` superset and an `errorResponses(...codes)` selector.
 *
 * The error body shape is generic — `{ key, message }` (+ `fields` for validation)
 * — with no domain identifiers.
 */
import { z } from 'zod';

/** Liveness response — `{ status: 'ok' }`. */
export const SCHEMA_HEALTH_LIVE_RESPONSE = z.object({
  status: z.literal('ok').describe('Liveness status'),
});

/** Readiness response — `{ status: 'ok', db: 'connected' }`. */
export const SCHEMA_HEALTH_READY_RESPONSE = z.object({
  status: z.literal('ok').describe('Readiness status'),
  db: z.literal('connected').describe('Database connection status'),
});

/** Validation error with field details. */
export const SCHEMA_VALIDATION_ERROR = z.object({
  key: z.literal('validation_error'),
  message: z.string().describe('Human-readable error message'),
  fields: z.array(z.object({
    path: z.string().describe('Field path (e.g., "email", "address.street")'),
    message: z.string().describe('Field-specific error message'),
  })).describe('List of field validation errors'),
});

/** Generic error response (passthrough allows additional error-specific fields). */
export const SCHEMA_GENERIC_ERROR = z.object({
  key: z.string().describe('Error key/code'),
  message: z.string().describe('Human-readable error message'),
});

/** Standard error response (union of validation and generic). */
export const SCHEMA_ERROR_RESPONSE = z.union([
  SCHEMA_VALIDATION_ERROR,
  SCHEMA_GENERIC_ERROR,
]);

/** Standard success response. */
export const SCHEMA_SUCCESS_RESPONSE = z.object({
  success: z.boolean().describe('Whether the operation was successful'),
});

/** Every error status code any API emits — the superset. */
export const ALL_ERROR_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 503] as const;

export type ErrorStatusCode = (typeof ALL_ERROR_STATUSES)[number];

/**
 * Build a response-map fragment mapping the given status codes to
 * `SCHEMA_ERROR_RESPONSE`. Spread into a route's `responses` object.
 *
 * @example
 * responses: { 200: ItemSchema, ...errorResponses(400, 404) }
 */
export function errorResponses<const C extends readonly ErrorStatusCode[]>(
  ...codes: C
): { [K in C[number]]: typeof SCHEMA_ERROR_RESPONSE } {
  const out = {} as Record<number, typeof SCHEMA_ERROR_RESPONSE>;
  for (const code of codes) out[code] = SCHEMA_ERROR_RESPONSE;
  return out as { [K in C[number]]: typeof SCHEMA_ERROR_RESPONSE };
}

/**
 * Common error responses (superset). Spread into a route's `responses` map to
 * include the standard error status codes, or use `errorResponses(...)` to pick
 * a subset.
 */
export const CommonErrorResponses = errorResponses(...ALL_ERROR_STATUSES);

/**
 * Declare a non-200 success schema **plus a 200 alias** for the same shape.
 *
 * Originally an Eden Treaty workaround: Eden derived a route's `data` type as
 * `Extract<Response, SuccessCodes>`, and Elysia inferred a phantom 200 entry
 * from the handler's return union — so on a route whose only *declared* success
 * code was non-200 (e.g. `201`), that inferred 200 carried the **whole** union,
 * error bodies included, which Eden then folded into `data`.
 *
 * Hono's `hc` declares no such phantom status, so non-200-success routes narrow
 * on their own and this is now **documentation**, not a workaround: it gives the
 * OpenAPI document a complete response map.
 *
 * ```ts
 * responses: { ...successResponses(201, CreatedSchema), ...errorResponses(400, 409) }
 * ```
 *
 * Passing `200` is a no-op alias of itself (`{ 200: schema }`).
 */
export function successResponses<const S extends number, T>(
  status: S,
  schema: T,
): { [K in S | 200]: T } {
  return { 200: schema, [status]: schema } as { [K in S | 200]: T };
}

export type SchemaErrorResponse = z.infer<typeof SCHEMA_ERROR_RESPONSE>;
export type SchemaValidationError = z.infer<typeof SCHEMA_VALIDATION_ERROR>;
export type SchemaSuccessResponse = z.infer<typeof SCHEMA_SUCCESS_RESPONSE>;
