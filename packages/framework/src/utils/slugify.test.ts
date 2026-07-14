import { describe, it, expect } from 'vitest';
import { slugify } from './slugify.ts';

describe('slugify', () => {
  it('should trim whitespace and lowercase', () => {
    expect(slugify('  Hello World  ')).toBe('hello-world');
  });

  it('should replace german umlauts', () => {
    expect(slugify('Füße')).toBe('fuesse');
    expect(slugify('Mädchen')).toBe('maedchen');
    expect(slugify('groß')).toBe('gross');
  });

  it('should replace accented characters', () => {
    expect(slugify('café')).toBe('cafe');
    expect(slugify('fiancée')).toBe('fiancee');
    expect(slugify('crème brûlée')).toBe('creme-brulee');
  });

  it('should replace special letters', () => {
    expect(slugify('şiş')).toBe('sis');
    expect(slugify('țară')).toBe('tara');
    expect(slugify('điện')).toBe('dien');
  });

  it('should remove non-word characters', () => {
    expect(slugify('hello!@# world$%^')).toBe('hello-world');
    expect(slugify('foo_bar')).toBe('foo_bar');
    expect(slugify('foo-bar')).toBe('foo-bar');
  });

  it('should handle multiple spaces', () => {
    expect(slugify('a   b   c')).toBe('a-b-c');
  });

  it('should handle empty string', () => {
    expect(slugify('')).toBe('');
  });
});
