---
'@octabits-io/framework': minor
---

Security hardening across `./events`, `./storage/postgres`, `./pii`, and
`./drizzle/event-outbox`.

**`./events` — SSE replay ignored `audience.users` (cross-user leak).** The
live fan-out path applied both delivery filters, but the `Last-Event-ID` replay
path ran only the permission half, so a durable event addressed to specific
users was delivered to every subscriber in the scope that reconnected. Since
`lastEventId` is client-supplied (header or query param) and replay reaches
back `lastEventId − replayLookback`, this was requestable on demand. Both paths
now share one exported predicate, `isEnvelopePermitted` — use it if you build
your own replay or catch-up source.

**`./storage/postgres` — `Cache-Control` default is now `private, no-store`.**
The serve handlers hardcoded `public, max-age=31536000, immutable` with no
override, marking access-controlled blobs publicly cacheable — a shared CDN or
reverse proxy could store one caller's object and re-serve it to another. The
new `ServeHandlerOptions.cacheControl` restores the old value where it is
actually correct (content-addressed public assets); `DEFAULT_CACHE_CONTROL` is
exported.

**`./storage/postgres` — 5xx responses no longer echo the storage error.** The
handlers wrote the underlying failure (potentially driver/SQL internals)
straight into the response body; they now emit a fixed `Internal error`,
matching `./server`'s production redaction. 4xx bodies are unchanged.

**`./pii` — the decrypted-key cache TTL is now enforced by the service.**
`createScopedKeyService` stamps and checks its own expiry on every read instead
of trusting the injected cache's eviction policy — the seam is structural, so a
consumer could satisfy it with a plain `Map` and pin plaintext age identities
in memory for the process's lifetime. New `cacheTtlMs` (default
`DEFAULT_KEY_CACHE_TTL_MS`, 5 min) and `dateProvider` deps. `ScopedKeyCache`
loses `has`, which existed only to answer a question the TTL check now owns.

**`./pii` — `destroyKeys()` can invalidate other processes.** Crypto-shredding
only ever dropped the calling process's cache; every other pod kept serving its
copy until its TTL lapsed. The new `onKeysDestroyed(scope)` seam broadcasts the
destruction (wire it to `./events`, `pg_notify`, or your bus; receivers call
`invalidateCache()`). A failing broadcast is logged via the new optional
`logger` dep and does not fail the destroy.

**`./drizzle/event-outbox` — a scope-less store now refuses multi-scope use.**
Omitting `scope` leaves no column to filter on, so `readSince` returned the
whole outbox and relabelled every envelope with the caller's `scopeKey` — a
cross-scope replay leak for anyone who omitted `scope` outside a genuinely
single-scope deployment. The store now throws on the second distinct
`scopeKey` it sees (append, notify, or read) instead of silently mixing them.

⚠️ Consumers serving genuinely public assets from `./storage/postgres` must
pass `cacheControl: 'public, max-age=31536000, immutable'` to keep CDN caching.

⚠️ A custom `ScopedKeyCache` implementation may drop its now-unused `has`.
Long-lived processes that relied on an unbounded key cache will re-read and
re-decrypt keys every `cacheTtlMs`; raise it if that matters more than the
in-memory exposure window.
