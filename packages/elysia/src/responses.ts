/**
 * Standard HTTP response schemas for Elysia route `response` maps, plus the
 * `CommonErrorResponses` superset and an `errorResponses(...codes)` selector.
 *
 * The error body shape is generic — `{ key, message }` (+ `fields` for validation)
 * — with no domain identifiers.
 */
import { z } from 'zod';

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
export const ALL_ERROR_STATUSES = [400, 401, 403, 404, 422, 429, 500, 503] as const;

export type ErrorStatusCode = (typeof ALL_ERROR_STATUSES)[number];

/**
 * Build an Elysia `response`-map fragment mapping the given status codes to
 * `SCHEMA_ERROR_RESPONSE`. Spread into a route's `response` object.
 *
 * @example
 * response: { 200: ItemSchema, ...errorResponses(400, 404) }
 */
export function errorResponses<const C extends readonly ErrorStatusCode[]>(
  ...codes: C
): { [K in C[number]]: typeof SCHEMA_ERROR_RESPONSE } {
  const out = {} as Record<number, typeof SCHEMA_ERROR_RESPONSE>;
  for (const code of codes) out[code] = SCHEMA_ERROR_RESPONSE;
  return out as { [K in C[number]]: typeof SCHEMA_ERROR_RESPONSE };
}

/**
 * Common error responses (superset). Spread into a route's `response` map to
 * include the standard error status codes, or use `errorResponses(...)` to pick
 * a subset.
 */
export const CommonErrorResponses = errorResponses(...ALL_ERROR_STATUSES);

export type SchemaErrorResponse = z.infer<typeof SCHEMA_ERROR_RESPONSE>;
export type SchemaValidationError = z.infer<typeof SCHEMA_VALIDATION_ERROR>;
export type SchemaSuccessResponse = z.infer<typeof SCHEMA_SUCCESS_RESPONSE>;
