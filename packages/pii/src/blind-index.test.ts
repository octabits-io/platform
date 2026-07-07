import { describe, expect, test } from 'vitest';
import { createBlindIndex, createBlindIndexService, MIN_BLIND_INDEX_KEY_LENGTH } from './blind-index.ts';

const KEY = 'a-sufficiently-long-blind-index-key';
const OTHER_KEY = 'another-sufficiently-long-index-key';

describe('createBlindIndex', () => {
  test('is deterministic for the same value and key', () => {
    const a = createBlindIndex('user@example.com', KEY);
    const b = createBlindIndex('user@example.com', KEY);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32); // HMAC-SHA256
  });

  test('normalizes Unicode (NFKC): composed and decomposed é produce the same index', () => {
    const composed = 'caf\u00e9@example.com'; // e-acute as a single composed code point
    const decomposed = 'cafe\u0301@example.com'; // e + combining acute accent
    expect(composed).not.toBe(decomposed);
    const a = createBlindIndex(composed, KEY);
    const b = createBlindIndex(decomposed, KEY);
    expect(a.equals(b)).toBe(true);
  });

  test('canonicalizes case and surrounding whitespace', () => {
    const a = createBlindIndex('  User@Example.COM ', KEY);
    const b = createBlindIndex('user@example.com', KEY);
    expect(a.equals(b)).toBe(true);
  });

  test('different keys produce different indexes for the same value', () => {
    const a = createBlindIndex('user@example.com', KEY);
    const b = createBlindIndex('user@example.com', OTHER_KEY);
    expect(a.equals(b)).toBe(false);
  });

  test('different values produce different indexes', () => {
    const a = createBlindIndex('user@example.com', KEY);
    const b = createBlindIndex('other@example.com', KEY);
    expect(a.equals(b)).toBe(false);
  });
});

describe('createBlindIndexService', () => {
  test('rejects an empty or too-short HMAC key at construction', () => {
    expect(() => createBlindIndexService('')).toThrow(/at least 16 characters/);
    expect(() => createBlindIndexService('x'.repeat(MIN_BLIND_INDEX_KEY_LENGTH - 1))).toThrow(/at least 16 characters/);
  });

  test('accepts a key at exactly the minimum length', () => {
    expect(() => createBlindIndexService('x'.repeat(MIN_BLIND_INDEX_KEY_LENGTH))).not.toThrow();
  });

  test('generateIndex returns null for empty-ish values and a digest otherwise', () => {
    const service = createBlindIndexService(KEY);
    expect(service.generateIndex(null)).toBeNull();
    expect(service.generateIndex(undefined)).toBeNull();
    expect(service.generateIndex('   ')).toBeNull();
    const idx = service.generateIndex('user@example.com');
    expect(idx).toBeInstanceOf(Buffer);
    expect(idx!.equals(createBlindIndex('user@example.com', KEY))).toBe(true);
  });
});
