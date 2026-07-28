---
"@octabits-io/framework": minor
"@octabits-io/nuxt-ui-kit": minor
---

Add the events stack: cross-process, two-lane event fan-out with SSE delivery.

framework:

- `./events` — `EventEnvelope` (+ Zod schema), the notify wire codec, `createEventHub` (in-process per-scope fan-out with audience/permission filtering, fail-closed), `createEventPublisher` (`emit(event, tx?)`; durable events append to the outbox in the caller's transaction — throws so a failed append rolls the state change back), `createEventRelay` (notification → outbox → hub with per-scope watermark and bigserial-gap recovery), and `createEventStreamHandler` — the SSE endpoint as a **plain fetch handler** (heartbeats, capped connection age, `Last-Event-ID` replay with lookback, per-subscriber connection caps, `x-accel-buffering: no`), registrable via `.mount()` with zero Elysia type budget.
- `./events/postgres` — `createPgNotifyListener`: one dedicated LISTEN connection per process (`pg` optional peer), full-jitter reconnect, `onReconnect` catch-up hook.
- `./drizzle/event-outbox` — `eventOutboxColumns` (spreadable, no `pgTable`; bigserial `id` is the envelope `seq`) + `createDrizzleEventOutboxStore`: outbox INSERT + `pg_notify` pointer in the same transaction (durable), inline notify with an 8000-byte guard (ephemeral), `readSince`, `prune`.
- `./elysia/events` — `createEventStreamRoute`, the thin `.use()`-style wrapper (literal-generic prefix) over the fetch handler.

nuxt-ui-kit:

- `./events` — `createEventStreamClient`: fetch-based SSE reader (header auth, so `Last-Event-ID`/reconnect are implemented here), full-jitter backoff with a `degraded` state past a threshold, durable-only watermark, bounded seen-id dedupe; `createSseFrameParser`; `useEventStream` Vue composable with reactive connection state.
