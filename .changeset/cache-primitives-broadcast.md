---
'@octabits-io/framework': minor
---

Cache-invalidation primitives:

- `LruCache.deletePrefix(prefix)` (utils): delete every string-keyed entry
  under a prefix, enabling namespace invalidation (e.g. everything for one
  tenant) without enumerating a key list that can drift from what was stored.
- `createScopedConfigCache.invalidate` now deletes by scope prefix instead of
  looping the cacheable-key set — entries for keys that have since left the
  cacheable set can no longer be stranded. The `ConfigLruCache` structural
  seam gains a required `deletePrefix` member.
- New `drizzle/broadcast` subpath: `createBroadcastChannel` — a minimal
  fire-and-forget broadcast over Postgres NOTIFY for cross-process
  coordination hints (cache invalidation and similar). Zod-validated payloads,
  at-most-once delivery with an `onReconnect` flush hook, publish-at-COMMIT
  when handed a transaction, and the same direct-URL LISTEN constraints as
  the events relay. Deliberately outside the events taxonomy: no envelope,
  outbox, audience, or SSE delivery.
