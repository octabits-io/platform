import { describe, it, expect } from 'vitest';
import {
  normalizeQueryParamToStringOrUndefined,
  normalizeQueryParamToIntOrUndefined,
  normalizeQueryParamToArrayOrUndefined
} from './query.ts'

describe('normalizeQueryParamToStringOrUndefined', () => {
  it('returns string for string input', () => {
    expect(normalizeQueryParamToStringOrUndefined('foo')).toBe('foo')
  })
  it('returns first string for array input', () => {
    expect(normalizeQueryParamToStringOrUndefined(['bar', 'baz'])).toBe('bar')
  })
  it('returns undefined for empty array', () => {
    expect(normalizeQueryParamToStringOrUndefined([])).toBeUndefined()
  })
  it('returns undefined for null/undefined', () => {
    expect(normalizeQueryParamToStringOrUndefined(null)).toBeUndefined()
    expect(normalizeQueryParamToStringOrUndefined(undefined)).toBeUndefined()
  })
})

describe('normalizeQueryParamToIntOrUndefined', () => {
  it('returns int for string input', () => {
    expect(normalizeQueryParamToIntOrUndefined('42')).toBe(42)
  })
  it('returns int for array input', () => {
    expect(normalizeQueryParamToIntOrUndefined(['7', '8'])).toBe(7)
  })
  it('returns undefined for non-numeric string', () => {
    expect(normalizeQueryParamToIntOrUndefined('foo')).toBeUndefined()
  })
  it('returns undefined for null/undefined', () => {
    expect(normalizeQueryParamToIntOrUndefined(null)).toBeUndefined()
    expect(normalizeQueryParamToIntOrUndefined(undefined)).toBeUndefined()
  })
})

describe('normalizeQueryParamToArrayOrUndefined', () => {
  it('returns array for array input', () => {
    expect(normalizeQueryParamToArrayOrUndefined(['foo', 'bar'])).toEqual(['foo', 'bar'])
  })
  it('returns array for string input', () => {
    expect(normalizeQueryParamToArrayOrUndefined('baz')).toEqual(['baz'])
  })
  it('returns undefined for null/undefined', () => {
    expect(normalizeQueryParamToArrayOrUndefined(null)).toBeUndefined()
    expect(normalizeQueryParamToArrayOrUndefined(undefined)).toBeUndefined()
  })
})
