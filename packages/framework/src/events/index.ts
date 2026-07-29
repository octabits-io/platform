/**
 * @octabits-io/framework/events — cross-process event fan-out with two lanes:
 * a durable, replayable lane backed by a consumer-owned transactional outbox,
 * and an ephemeral fire-and-forget lane carried inline on the notification
 * channel. Scope-agnostic: `scopeKey` is whatever partitions your consumers
 * (a tenant id, a workspace, …).
 *
 * The pieces, producer → browser:
 *
 * 1. {@link createEventPublisher} — `emit(event, tx)` at the write site;
 *    durable events land in the outbox in the same transaction.
 * 2. `drizzle/event-outbox` (subpath) — the outbox store: row + pointer
 *    notification at COMMIT.
 * 3. `events/postgres` (subpath) — the LISTEN side: one dedicated connection
 *    per process, reconnect built in.
 * 4. {@link createEventRelay} — notification → outbox read → hub, with
 *    watermark catch-up.
 * 5. {@link createEventHub} — in-process per-scope fan-out with per-subscriber
 *    audience/permission filtering.
 * 6. {@link createEventStreamHandler} — the SSE endpoint (plain fetch
 *    handler; Elysia wrapper at `elysia/events`).
 *
 * The matching browser client (fetch-based SSE reader, watermark, dedupe,
 * backoff) lives in `@octabits-io/nuxt-ui-kit/events`.
 */
export type {
  EventLane,
  EventActor,
  EventAudience,
  EventEnvelope,
  EventInput,
  EventOutboxStore,
  EventNotificationListener,
} from './types.ts';
export {
  MAX_NOTIFY_PAYLOAD_BYTES,
  encodeEventPointer,
  encodeInlineEvent,
  decodeEventNotification,
  type DecodedEventNotification,
} from './codec.ts';
export { EVENT_ENVELOPE_SCHEMA, EVENT_ACTOR_SCHEMA, EVENT_AUDIENCE_SCHEMA } from './schema.ts';
export { createEventHub, type EventHub, type EventHubSubscriber, type PublishStats, type CreateEventHubDeps } from './hub.ts';
export {
  createEventPublisher,
  type EventPublisher,
  type EventDataMap,
  type CreateEventPublisherDeps,
} from './publisher.ts';
export { createEventRelay, type EventRelay, type CreateEventRelayDeps } from './relay.ts';
export {
  createEventStreamHandler,
  type EventStreamHandler,
  type CreateEventStreamHandlerDeps,
  type ResolvedEventSubscriber,
  type ResolveEventSubscriber,
} from './sse.ts';
