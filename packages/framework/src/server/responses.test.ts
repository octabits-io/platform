/**
 * Response-schema helpers: the `CommonErrorResponses` superset, the
 * `errorResponses(...codes)` selector, and `successResponses`' 200 alias.
 *
 * Framework-neutral, so tested here rather than through a glue module.
 */
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_ERROR_RESPONSE,
  SCHEMA_SUCCESS_RESPONSE,
  CommonErrorResponses,
  errorResponses,
  successResponses,
  ALL_ERROR_STATUSES,
} from './responses';

describe('response schemas', () => {
  it('CommonErrorResponses covers the full superset', () => {
    expect(Object.keys(CommonErrorResponses).map(Number).sort((a, b) => a - b)).toEqual([...ALL_ERROR_STATUSES].sort((a, b) => a - b));
  });

  it('errorResponses selects a subset mapped to the error schema', () => {
    const r = errorResponses(400, 404);
    expect(Object.keys(r).map(Number).sort((a, b) => a - b)).toEqual([400, 404]);
    expect(r[400]).toBe(SCHEMA_ERROR_RESPONSE);
  });

  it('successResponses aliases a non-200 success code onto 200', () => {
    const r = successResponses(201, SCHEMA_SUCCESS_RESPONSE);
    expect(Object.keys(r).map(Number).sort((a, b) => a - b)).toEqual([200, 201]);
    expect(r[201]).toBe(SCHEMA_SUCCESS_RESPONSE);
    expect(r[200]).toBe(SCHEMA_SUCCESS_RESPONSE);
  });

  it('successResponses(200, …) is a no-op alias of itself', () => {
    const r = successResponses(200, SCHEMA_SUCCESS_RESPONSE);
    expect(Object.keys(r)).toEqual(['200']);
    expect(r[200]).toBe(SCHEMA_SUCCESS_RESPONSE);
  });

  it('successResponses composes with errorResponses into a route response map', () => {
    const map = { ...successResponses(201, SCHEMA_SUCCESS_RESPONSE), ...errorResponses(400, 409) };
    expect(Object.keys(map).map(Number).sort((a, b) => a - b)).toEqual([200, 201, 400, 409]);
  });
});
