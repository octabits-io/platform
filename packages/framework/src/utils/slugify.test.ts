import { describe, it, expect } from 'vitest';
import { isUrlFriendly, slugify } from './slugify.ts';

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

describe('isUrlFriendly', () => {
  it('accepts what slugify produces', () => {
    for (const input of ['Hello World', 'Grüße aus München', 'a  b---c']) {
      expect(isUrlFriendly(slugify(input))).toBe(true);
    }
  });

  it('rejects the shapes a slug must never take', () => {
    expect(isUrlFriendly('Hello World')).toBe(false); // spaces
    expect(isUrlFriendly('héllo')).toBe(false); // unescaped diacritic
    expect(isUrlFriendly('a/b')).toBe(false); // path separator
    expect(isUrlFriendly('a.b')).toBe(false); // dot
    expect(isUrlFriendly('')).toBe(false); // a slug of nothing is not a slug
  });

  it('is a URL-safety check, not a slug-shape check — case and underscores pass', () => {
    // Worth knowing before using it as a validator: it answers "can this ride
    // in a path segment unescaped?", so `Hello_World` is fine even though
    // `slugify` would never produce it.
    expect(isUrlFriendly('Hello')).toBe(true);
    expect(isUrlFriendly('Hello_World-2')).toBe(true);
  });
});
