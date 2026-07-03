---
"@octabits-io/foundation": minor
---

Extend the `@octabits-io/foundation/utils` subpath with three widely-used platform
utilities:

- `createDateProvider()` / `DateProvider` — the `{ now(): Date }` clock-injection seam.
- `createLruCacheService({ dateProvider })` → `.createCache<K, V>({ maxSize, ttlMs })` —
  a generic LRU + TTL cache over a `Map`, depending only on `DateProvider`. Also exports
  `LruCache`, `LruCacheOptions`, `LruCacheService`, `LruCacheServiceDeps`.
- `withRetry()` — exponential-backoff-with-jitter retry helper. Its `Logger` dependency
  is a structural/injected type (from `@octabits-io/foundation/logger`), so it does not
  hard-depend on any concrete logger. Also exports `RetryConfig` / `RetryOptions`.
