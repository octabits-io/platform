import { describe, it, expect } from 'vitest';

import { createLruCacheService } from './LruCacheService.ts';
import type { DateProvider } from './DateProvider.ts';

/** A controllable clock for deterministic TTL testing. */
function createFakeDateProvider(startMs = 0): DateProvider & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createLruCacheService', () => {
  it('stores and retrieves values', () => {
    const service = createLruCacheService({ dateProvider: createFakeDateProvider() });
    const cache = service.createCache<string, number>({ maxSize: 3, ttlMs: 0 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('reports size and has()', () => {
    const service = createLruCacheService({ dateProvider: createFakeDateProvider() });
    const cache = service.createCache<string, number>({ maxSize: 3, ttlMs: 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size()).toBe(2);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('z')).toBe(false);
  });

  it('evicts the least-recently-used entry when at capacity', () => {
    const service = createLruCacheService({ dateProvider: createFakeDateProvider() });
    const cache = service.createCache<string, number>({ maxSize: 2, ttlMs: 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    // Touch 'a' so 'b' becomes the LRU entry
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('expires entries after ttlMs', () => {
    const clock = createFakeDateProvider(1000);
    const service = createLruCacheService({ dateProvider: clock });
    const cache = service.createCache<string, number>({ maxSize: 5, ttlMs: 100 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    clock.advance(101);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.has('a')).toBe(false);
  });

  it('never expires when ttlMs is 0', () => {
    const clock = createFakeDateProvider(0);
    const service = createLruCacheService({ dateProvider: clock });
    const cache = service.createCache<string, number>({ maxSize: 5, ttlMs: 0 });
    cache.set('a', 1);
    clock.advance(1_000_000);
    expect(cache.get('a')).toBe(1);
  });

  it('throws on maxSize < 1 (would loop forever during eviction)', () => {
    const service = createLruCacheService({ dateProvider: createFakeDateProvider() });
    expect(() => service.createCache<string, number>({ maxSize: 0, ttlMs: 0 })).toThrow(/positive integer/);
    expect(() => service.createCache<string, number>({ maxSize: -1, ttlMs: 0 })).toThrow(/positive integer/);
    expect(() => service.createCache<string, number>({ maxSize: 1.5, ttlMs: 0 })).toThrow(/positive integer/);
  });

  it('supports delete and clear', () => {
    const service = createLruCacheService({ dateProvider: createFakeDateProvider() });
    const cache = service.createCache<string, number>({ maxSize: 5, ttlMs: 0 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
