import { describe, it, expect, assert } from 'vitest';

import { tryDecodeBase64 } from './base64.ts';

describe('tryDecodeBase64', () => {
  describe('valid base64 strings', () => {
    it('decodes simple text correctly', () => {
      const result = tryDecodeBase64('SGVsbG8gV29ybGQ='); // "Hello World"
      assert(result.ok);
      expect(result.value).toBe('Hello World');
    });

    it('decodes empty string', () => {
      const result = tryDecodeBase64('');
      assert(result.ok);
      expect(result.value).toBe('');
    });

    it('decodes base64 with padding', () => {
      const result = tryDecodeBase64('SGVsbG8='); // "Hello"
      assert(result.ok);
      expect(result.value).toBe('Hello');
    });

    it('decodes base64 with single padding', () => {
      const result = tryDecodeBase64('SGk='); // "Hi"
      assert(result.ok);
      expect(result.value).toBe('Hi');
    });

    it('decodes base64 with double padding', () => {
      const result = tryDecodeBase64('SA=='); // "H"
      assert(result.ok);
      expect(result.value).toBe('H');
    });

    it('decodes base64 without padding', () => {
      const result = tryDecodeBase64('SGVsbG8gV29ybGQ'); // This should fail due to invalid length
      expect(result.ok).toBe(false);
    });

    it('decodes base64 with special characters', () => {
      const result = tryDecodeBase64('VGVzdCEhIQ=='); // "Test!!!"
      assert(result.ok);
      expect(result.value).toBe('Test!!!');
    });

    it('decodes simple binary data', () => {
      const result = tryDecodeBase64('QUJDEw=='); // Simple binary data
      assert(result.ok);
      expect(result.value).toBe('ABC\x13');
    });
  });

  describe('invalid base64 strings', () => {
    it('rejects string with invalid length (not multiple of 4)', () => {
      const result = tryDecodeBase64('SGVsbG8'); // 7 characters
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('rejects string with invalid characters', () => {
      const result = tryDecodeBase64('SGVs@G8='); // contains @
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('rejects string with invalid characters (space)', () => {
      const result = tryDecodeBase64('SGVs bG8='); // contains space
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('rejects string with invalid characters (special symbols)', () => {
      const result = tryDecodeBase64('SGVs#bG8='); // contains #
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('rejects string with incorrect padding position', () => {
      const result = tryDecodeBase64('SGVs=bG8'); // padding in wrong position
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('rejects string with too much padding', () => {
      const result = tryDecodeBase64('SGVs==='); // too many = characters
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('rejects malformed base64 that passes regex but fails decoding', () => {
      const result = tryDecodeBase64('SGVsbG!'); // Invalid character but length is wrong anyway
      assert(!result.ok);
      expect(result.error).toBe(null);
    });
  });

  describe('edge cases', () => {
    it('handles single character input', () => {
      const result = tryDecodeBase64('A');
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('handles very long valid base64', () => {
      const longText = 'A'.repeat(1000);
      const encoded = btoa(longText);
      const result = tryDecodeBase64(encoded);
      assert(result.ok);
      expect(result.value).toBe(longText);
    });

    it('handles base64 with URL-safe characters (should fail)', () => {
      const result = tryDecodeBase64('SGVsbG8_V29ybGQ-'); // URL-safe base64
      assert(!result.ok);
      expect(result.error).toBe(null);
    });

    it('handles mixed case correctly', () => {
      const result = tryDecodeBase64('dGVzdA=='); // "test"
      assert(result.ok);
      expect(result.value).toBe('test');
    });
  });

  describe('return type validation', () => {
    it('returns correct success type structure', () => {
      const result = tryDecodeBase64('SGVsbG8=');
      expect(result).toHaveProperty('ok');
      if (result.ok) {
        expect(result).toHaveProperty('value');
        expect(result).not.toHaveProperty('error');
      }
    });

    it('returns correct error type structure', () => {
      const result = tryDecodeBase64('invalid');
      expect(result).toHaveProperty('ok');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result).toHaveProperty('error');
        expect(result).not.toHaveProperty('value');
      }
    });
  });
});
