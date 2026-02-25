import { describe, it, expect } from 'vitest';
import { normalizePaginationLimit, MAX_UNLIMITED_RESULTS } from './pagination.ts';

describe('MAX_UNLIMITED_RESULTS', () => {
  it('is 10000', () => {
    expect(MAX_UNLIMITED_RESULTS).toBe(10000);
  });
});

describe('normalizePaginationLimit', () => {
  it('returns MAX_UNLIMITED_RESULTS when limit is -1', () => {
    expect(normalizePaginationLimit(-1)).toBe(MAX_UNLIMITED_RESULTS);
  });

  it('returns the original limit for positive values', () => {
    expect(normalizePaginationLimit(10)).toBe(10);
    expect(normalizePaginationLimit(50)).toBe(50);
    expect(normalizePaginationLimit(100)).toBe(100);
  });

  it('returns 0 when limit is 0', () => {
    expect(normalizePaginationLimit(0)).toBe(0);
  });

  it('returns 1 when limit is 1', () => {
    expect(normalizePaginationLimit(1)).toBe(1);
  });

  it('passes through large values unchanged', () => {
    expect(normalizePaginationLimit(999999)).toBe(999999);
  });

  it('passes through negative values other than -1 unchanged', () => {
    expect(normalizePaginationLimit(-2)).toBe(-2);
    expect(normalizePaginationLimit(-100)).toBe(-100);
  });
});
