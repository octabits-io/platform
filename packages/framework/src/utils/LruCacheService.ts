/**
 * LRU Cache Service
 *
 * A factory service for creating LRU (Least Recently Used) caches with TTL support.
 * Uses DateProvider for consistent, testable time handling.
 */

import type { DateProvider } from './DateProvider.ts';

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface LruCacheOptions {
  /** Maximum number of entries in the cache */
  maxSize: number;
  /** Time to live in milliseconds (0 = no expiration) */
  ttlMs: number;
}

export interface LruCache<K, V> {
  /** Get a value from the cache (returns undefined if not found or expired) */
  get(key: K): V | undefined;
  /** Set a value in the cache */
  set(key: K, value: V): void;
  /** Delete a value from the cache */
  delete(key: K): boolean;
  /** Clear all values from the cache */
  clear(): void;
  /** Get the current number of entries in the cache */
  size(): number;
  /** Check if a key exists and is not expired */
  has(key: K): boolean;
}

export interface LruCacheServiceDeps {
  dateProvider: DateProvider;
}

/**
 * Creates an LRU cache service that provides a factory for creating caches.
 *
 * @param deps.dateProvider - DateProvider for consistent time handling
 * @returns A service with a createCache method
 *
 * @example
 * ```typescript
 * const lruCacheService = createLruCacheService({ dateProvider });
 *
 * const cache = lruCacheService.createCache<string, TenantKeys>({
 *   maxSize: 100,
 *   ttlMs: 5 * 60 * 1000, // 5 minutes
 * });
 *
 * cache.set('tenant-1', keys);
 * const keys = cache.get('tenant-1');
 * ```
 */
export function createLruCacheService({ dateProvider }: LruCacheServiceDeps) {
  /**
   * Create a new LRU cache with the specified options.
   */
  function createCache<K, V>(options: LruCacheOptions): LruCache<K, V> {
    const { maxSize, ttlMs } = options;
    // Programming error, not a Result: a non-positive maxSize would make the
    // eviction loop in set() spin forever (nothing left to evict).
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new Error(`LruCache maxSize must be a positive integer, got: ${maxSize}`);
    }
    const cache = new Map<K, CacheEntry<V>>();

    function getNow(): number {
      return dateProvider.now().getTime();
    }

    function isExpired(entry: CacheEntry<V>): boolean {
      return ttlMs > 0 && getNow() > entry.expiresAt;
    }

    function evictOldest(): void {
      // Map maintains insertion order, so the first key is the oldest
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }

    function get(key: K): V | undefined {
      const entry = cache.get(key);
      if (!entry) {
        return undefined;
      }

      if (isExpired(entry)) {
        cache.delete(key);
        return undefined;
      }

      // Move to end (most recently used) by re-inserting
      cache.delete(key);
      cache.set(key, entry);

      return entry.value;
    }

    function set(key: K, value: V): void {
      // If key exists, delete it first so it moves to the end
      if (cache.has(key)) {
        cache.delete(key);
      }

      // Evict oldest if at capacity
      while (cache.size >= maxSize) {
        evictOldest();
      }

      const entry: CacheEntry<V> = {
        value,
        expiresAt: ttlMs > 0 ? getNow() + ttlMs : Infinity,
      };

      cache.set(key, entry);
    }

    function deleteKey(key: K): boolean {
      return cache.delete(key);
    }

    function clear(): void {
      cache.clear();
    }

    function size(): number {
      return cache.size;
    }

    function has(key: K): boolean {
      const entry = cache.get(key);
      if (!entry) {
        return false;
      }
      if (isExpired(entry)) {
        cache.delete(key);
        return false;
      }
      return true;
    }

    return {
      get,
      set,
      delete: deleteKey,
      clear,
      size,
      has,
    };
  }

  return {
    createCache,
  };
}

export type LruCacheService = ReturnType<typeof createLruCacheService>;
