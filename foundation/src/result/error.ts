import type { Result } from './types.ts';

export interface OctError {
  key: string;
  message: string;
}

export type OctErrorWithKey<T extends string = string> = {
  key: T;
  message: string;
};

export interface OctExceptionError extends OctErrorWithKey<'exception'> {
  cause?: unknown;
}

export const toOctError = (error: unknown): OctError => {
  if (isOctError(error)) {
    return error;
  } else if (typeof error === 'string') {
    return {message: error, key: 'general'};
  } else if (error instanceof Error) {
    return {message: error.message, key: error.name ?? 'general'};
  } else {
    return {message: 'General error', key: 'general'};
  }
}


// ============================================================================
// API Error Response Types (Discriminated Union)
// ============================================================================

/** Base API error with key as discriminator */
interface BaseApiError extends OctError {
}

/** Validation error with field details */
export interface ValidationApiError extends OctErrorWithKey<'validation_error'> {
  fields: Array<{
    path: string;
    message: string;
  }>;
}

/** Resource not found error */
export interface NotFoundApiError extends BaseApiError {
  key: `${string}_not_found`;
  resourceId?: string | number;
}

/** Generic bad request error */
export interface BadRequestApiError extends BaseApiError {
  key: 'bad_request';
}

/** Authorization error */
export interface UnauthorizedApiError extends BaseApiError {
  key: 'unauthorized';
}

/** Permission denied error */
export interface ForbiddenApiError extends BaseApiError {
  key: 'forbidden';
}

/** Internal server error */
export interface InternalApiError extends BaseApiError {
  key: 'internal_server_error';
}

/** Discriminated union of all API error responses */
export type ApiErrorResponse =
  | ValidationApiError
  | NotFoundApiError
  | BadRequestApiError
  | UnauthorizedApiError
  | ForbiddenApiError
  | InternalApiError;


export const isOctError = (error: unknown): error is OctError => {
  return typeof error === 'object' && error !== null && 'message' in error && 'key' in error;
}

export const isAbortError = (error: unknown): error is Error & {name: string} => {
  return error instanceof Error && error.name === 'AbortError';
}

function toExceptionError(thrown: unknown): OctExceptionError {
  if (thrown instanceof Error) {
    return { key: 'exception', message: thrown.message, cause: thrown };
  }
  if (typeof thrown === 'string') {
    return { key: 'exception', message: thrown, cause: thrown };
  }
  return { key: 'exception', message: 'An unknown error occurred', cause: thrown };
}

export function tryCatch<T>(fn: () => T): Result<T, OctExceptionError> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: toExceptionError(e) };
  }
}

export function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, OctExceptionError>> {
  return fn().then(
    (value) => ({ ok: true, value }) as Result<T, OctExceptionError>,
    (e) => ({ ok: false, error: toExceptionError(e) }),
  );
}
