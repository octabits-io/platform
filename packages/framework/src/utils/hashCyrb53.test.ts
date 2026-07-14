import { describe, expect, it } from 'vitest';
import { hashCyrb53 } from './hashCyrb53.ts';

describe('hashCyrb53', () => {
  it('is deterministic for the same input and seed', () => {
    expect(hashCyrb53('hello world')).toBe(hashCyrb53('hello world'));
    expect(hashCyrb53('hello world', 7)).toBe(hashCyrb53('hello world', 7));
  });

  it('returns a hex string', () => {
    expect(hashCyrb53('anything')).toMatch(/^[0-9a-f]+$/);
  });

  it('differs for different inputs', () => {
    expect(hashCyrb53('a')).not.toBe(hashCyrb53('b'));
    expect(hashCyrb53('')).not.toBe(hashCyrb53(' '));
  });

  it('differs for different seeds', () => {
    expect(hashCyrb53('same input', 0)).not.toBe(hashCyrb53('same input', 1));
  });

  it('is insensitive to input length collisions (53-bit spread)', () => {
    // A handful of near-identical strings should all hash apart.
    const hashes = new Set(
      ['abc', 'acb', 'bac', 'bca', 'cab', 'cba'].map((s) => hashCyrb53(s)),
    );
    expect(hashes.size).toBe(6);
  });
});
