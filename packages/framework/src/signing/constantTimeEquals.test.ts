import { describe, it, expect } from 'vitest';
import { constantTimeEquals } from './constantTimeEquals.ts';

describe('constantTimeEquals', () => {
  it('reports equal strings as equal', () => {
    expect(constantTimeEquals('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('reports unequal same-length strings as unequal', () => {
    expect(constantTimeEquals('s3cret-token', 's3cret-tokeN')).toBe(false);
    // Differing in the first byte only.
    expect(constantTimeEquals('abcdef', 'zbcdef')).toBe(false);
  });

  it('reports unequal different-length strings as unequal', () => {
    expect(constantTimeEquals('s3cret', 's3cret-token')).toBe(false);
    expect(constantTimeEquals('s3cret-token', 's3cret')).toBe(false);
    // A prefix must not pass — the digest, not the shared prefix, decides.
    expect(constantTimeEquals('', 'x')).toBe(false);
  });

  it('handles empty strings on both sides', () => {
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('compares multi-byte UTF-8 by content', () => {
    expect(constantTimeEquals('パスワード', 'パスワード')).toBe(true);
    expect(constantTimeEquals('パスワード', 'パスワート')).toBe(false);
  });

  it('does not throw on a length mismatch (node:crypto timingSafeEqual would)', () => {
    // The digest-first design is what makes this safe: timingSafeEqual only
    // ever sees two 32-byte buffers, so no length guard is needed.
    expect(() => constantTimeEquals('a', 'a-much-longer-candidate-value')).not.toThrow();
  });
});
