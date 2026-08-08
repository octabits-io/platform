# Events

Cross-process, two-lane event fan-out with SSE delivery: a **durable** lane
backed by a consumer-owned transactional outbox (at-least-once, replayable by
watermark) and an **ephemeral** fire-and-forget lane carried inline on the
notification channel. Scope-agnostic — `scopeKey` is whatever partitions your
consumers (a tenant id, a workspace, a constant in single-scope deployments).

Four subpaths, split so no import drags in a vendor SDK it doesn't need:

| Subpath | Deps | Contents |
| --- | --- | --- |
| `./events` | `zod` | Envelope + schema, notify codec, hub, publisher, relay, SSE fetch handler |
| `./events/postgres` | `pg` (optional peer) | `createPgNotifyListener` — the LISTEN side |
| `./drizzle/event-outbox` | `drizzle-orm` (optional peer) | `eventOutboxColumns` + the outbox store |
| `./hono/events` | `hono` (optional peer) | Thin sub-app wrapper over the fetch handler |
| `./drizzle/broadcast` | `drizzle-orm` + `pg` (optional peers) | `createBroadcastChannel` — NOTIFY-only coordination hints, outside the event taxonomy (see below) |

The browser client (fetch-based SSE reader + Vue composable) is
`@octabits-io/nuxt-ui-kit/events`.

## The shape

```
 producer process                        subscriber process (api)
 ───────────────────                     ─────────────────────────
 db.transaction(tx =>                    createPgNotifyListener ──▶ createEventRelay
   write state                             (dedicated LISTEN conn)     │ pointer → readSince
   publisher.emit(event, tx) ──┐                                       ▼
 )                             │         createEventHub (per-scope fan-out, audience filter)
   │ durable: outbox row       │                                       │
   ▼ + pg_notify(pointer)      │ ephemeral:                            ▼
 event_outbox table            └─ pg_notify(envelope inline)     createEventStreamHandler ──▶ SSE ──▶ browser
 (consumer-owned)                                                (plain fetch handler)
```

## Why an outbox, and why the same transaction

`emit(event, tx)` with a durable event inserts the outbox row **and** issues
`pg_notify` on the caller's transaction. Postgres delivers NOTIFY at COMMIT,
so the state change, the row, and the wakeup are one atomic unit: you can
never notify about a write that rolled back, and never commit a write whose
event was lost. This is also why the store and publisher **throw** on failure
instead of returning a `Result` — inside the transaction, the throw is the
rollback. Do not wrap `emit` in a catch-and-continue inside a transaction.

The row is the fact; the notification is only a `(scopeKey, seq)` pointer.
A subscriber that missed notifications (LISTEN reconnect, pod restart,
browser offline) catches up by reading the outbox from its watermark.

## Setting it up

### 1. The table (consumer-owned)

```ts
import { pgTable, text, index } from 'drizzle-orm/pg-core';
import { eventOutboxColumns } from '@octabits-io/framework/drizzle/event-outbox';

export const eventOutbox = pgTable(
  'event_outbox',
  {
    ...eventOutboxColumns,
    tenantId: text('tenant_id').notNull(), // your scope column — or omit it entirely
  },
  (t) => [index('event_outbox_scope_seq_idx').on(t.tenantId, t.id)],
);
```

The bigserial `id` **is** the envelope `seq`. The scope column, constraints,
RLS policies, and the prune schedule are yours. Index `(scope, id)` — every
read is `scope = ? AND id > ?`.

### 2. Store + publisher (every process that writes)

```ts
import { createEventPublisher } from '@octabits-io/framework/events';
import { createDrizzleEventOutboxStore } from '@octabits-io/framework/drizzle/event-outbox';

const store = createDrizzleEventOutboxStore({
  db, table: eventOutbox, channel: 'app_events',
  scope: { column: 'tenantId' }, // stamped from envelope.scopeKey; omit in single-scope apps
});
// Omitting `scope` means there is no column to filter on, so readSince() cannot
// restrict replay to one scope — it would hand every scope's events to whoever
// reconnects. The store enforces that: it throws as soon as it sees a second
// distinct scopeKey rather than mixing them. If that fires, configure a scope.
const publisher = createEventPublisher({ store });

// At a write site:
await db.transaction(async (tx) => {
  const order = await createOrder(params, tx);
  await publisher.emit({
    type: 'order.created',           // your taxonomy — dotted, past tense works well
    scopeKey, lane: 'durable',
    data: { orderId: order.id },     // identifiers, never entities
    audience: { permission: { orders: ['read'] } }, // opaque — evaluated by YOUR predicate
    resources: [`order:${order.id}`],
  }, tx);
});

// Ephemeral (progress ticks, invalidation hints): no row, inline payload,
// hard-capped under pg_notify's ~8000-byte limit — encodeInlineEvent throws over it.
await publisher.emit({ type: 'sync.progress', scopeKey, lane: 'ephemeral', data: { done: 3, total: 9 } });
```

#### Typed emit (opt-in)

The framework never knows your event taxonomy, but the publisher can hold you
to it. Declare the vocabulary once as Zod schemas, derive the `EventDataMap`
from it, and both layers enforce the same contract:

```ts
const EVENT_SCHEMAS = {
  'order.created': z.object({ orderId: z.number() }),
  'sync.progress': z.object({ done: z.number(), total: z.number() }),
} as const;
type AppEvents = { [K in keyof typeof EVENT_SCHEMAS]: z.infer<(typeof EVENT_SCHEMAS)[K]> };

const publisher = createEventPublisher<AppEvents>({ store, payloadSchemas: EVENT_SCHEMAS });

await publisher.emit({ type: 'order.created', scopeKey, lane: 'durable', data: { orderId: 7 } });
// type not in the map, or data of the wrong shape → compile error
```

- The generic makes `emit` correlate `type` with its payload shape at compile
  time; `payloadSchemas` enforces it at runtime for whatever the type system
  couldn't see (casts, JSON boundaries).
- When `payloadSchemas` is present it is **authoritative**: emitting an
  unregistered type throws, and a schema-failing payload throws — the same
  emit-site-programming-error stance as the envelope validation (inside a
  transaction, the throw is the rollback).
- Validation only checks, it never strips — consumer-merged extras on `data`
  (e.g. an inline activity row) survive untouched.
- Both default off: an unparameterized publisher without `payloadSchemas`
  behaves exactly as before (`type: string`, `data: unknown`).

### 3. Listener + relay + hub (the process serving subscribers)

```ts
import { createEventHub, createEventRelay } from '@octabits-io/framework/events';
import { createPgNotifyListener } from '@octabits-io/framework/events/postgres';

const hub = createEventHub({ logger });
const listener = createPgNotifyListener({
  connectionString: databaseDirectUrl, // MUST bypass PgBouncer transaction pooling
  channel: 'app_events',
  logger,
});
const relay = createEventRelay({ hub, store, listener, logger });
await relay.start();   // …and relay.stop() in graceful shutdown
```

Listener constraints, learned the hard way with pg-boss: it must be a
**dedicated connection** (a pooled checkout silently drops the LISTEN
registration on reset) and must **bypass transaction-mode poolers**. Reconnect
is built in (full jitter); after a reconnect the relay re-reads every active
scope from its watermark, because notifications sent while the listener was
down are gone.

If the store used for relay/replay reads serves many scopes on one dedicated
connection, remember an RLS-scoped connection is a single client — the relay
already serializes its reads, but the connection you bind is your choice
(multi-scope readers typically want an RLS-bypassing one).

### 4. The SSE endpoint

```ts
import { createEventStreamHandler } from '@octabits-io/framework/events';

const { handler, metrics } = createEventStreamHandler({
  hub,
  store, // enables Last-Event-ID replay; omit for a live-only stream
  resolveSubscriber: async (request) => {
    const auth = await validateBearer(request.headers.get('authorization'));
    if (!auth) return null; // → 401
    return {
      scopeKey: auth.scopeKey,
      subscriberId: auth.userId,
      can: (permission) => auth.grants.allows(permission), // your RBAC — opaque to the framework
    };
  },
});

app.mount('/events', handler);
```

Prefer `.mount()`: the handler is a plain `(request) => Response` on purpose —
it spends **no route-type budget** (the design was forced by a real consumer's
Elysia route chain dying of TS2589 from one more `.use()`, and the property is
worth keeping on Hono) and emits no client types, which is fine because
browsers consume the stream with the kit's SSE reader, not an API client. A
conventional sub-app wrapper exists at `./hono/events` (`createEventStreamApp`)
for `app.route('/events', …)` registration.

What the handler bakes in:

- `x-accel-buffering: no` — without it, buffering reverse proxies (nginx)
  hold the stream forever with no error anywhere. Also audit the rest of your
  proxy chain: **Traefik's `buffering` middleware buffers entire responses**
  regardless of options and kills SSE on any router it touches.
- Comment-frame heartbeats (default 20 s) under proxy idle timeouts.
- **Capped connection age** (default 5 min): the server closes the stream so
  auth is re-resolved on reconnect. Reconnect is a routine cycle, not an
  error — which also means replay is exercised constantly.
- Per-subscriber connection caps (default 5 → 429).
- **The watermark rule**: only durable events carry an SSE `id:` line. The
  client persists the last id as its replay watermark; an ephemeral id there
  would point at nothing in the outbox.

## Delivery filtering (who receives what)

Evaluated per subscriber at delivery time, in the hub:

1. Scope: `envelope.scopeKey === subscriber.scopeKey`. Always.
2. `audience.users` — personal targeting; omitted = scope-wide.
3. `audience.permission` — an **opaque value** evaluated by the subscriber's
   `can(...)`. The framework never interprets it; your permission model stays
   yours. A permission-carrying event with no evaluator is withheld
   (**fail closed**).

Filters 2 and 3 both apply (AND) and live in one exported predicate,
`isEnvelopePermitted`. Replay reads the outbox directly and never passes
through `hub.publish`, so it calls that same predicate rather than re-deriving
the rule — a second copy is how the replay path once lost the `audience.users`
filter and delivered user-targeted events to every subscriber in the scope.
**If you build your own replay or catch-up source, run `isEnvelopePermitted`
on every envelope before you emit it.**

## Ordering, replay, and the bigserial gap

`seq` is assigned at INSERT but becomes visible in COMMIT order, so a lower
`seq` can commit *after* a higher one was already delivered. Live delivery is
safe (NOTIFY fires at commit); the trap is watermark-based replay. Both read
paths compensate by **over-reading and deduplicating**:

- the relay reads from `min(watermark, pointer.seq − 1)`;
- the SSE handler replays from `lastEventId − replayLookback` (default 100).

Consequence: delivery is **at-least-once, everywhere**. Consumers dedupe by
envelope `id` (the kit client does this with a bounded seen-id set).

## Retention

The outbox is a delivery log, not a product surface — prune it short
(`store.prune(before)` from an existing sweep; ~24 h is plenty, a returning
client older than that should re-sync state, not replay history). If you need
a user-facing "what happened" feed, that is a separate table with its own
retention, written by the same emit.

## Broadcast channels (`./drizzle/broadcast`)

`createBroadcastChannel({ channel, schema })` is the deliberately-small
sibling of the event pipeline: a fire-and-forget signal between processes
sharing one database — cache-invalidation hints, "reload X" pokes. No
envelope, no outbox, no audience filtering, no SSE: a broadcast message is a
**hint, not a fact**, and delivery is at-most-once with no replay. Every
consumer therefore needs an independent correctness backstop (typically a TTL
on whatever the broadcast invalidates); the channel only shortens the
staleness window.

```ts
import { createBroadcastChannel } from '@octabits-io/framework/drizzle/broadcast';

const invalidations = createBroadcastChannel({
  channel: 'app_cache_invalidation',
  schema: z.object({ namespace: z.string(), scopeKey: z.string() }),
  logger,
});

// Best-effort hint — any process, regular (pooled) connection. Database
// failures are logged, never thrown; safe to void-discard.
await invalidations.publish(db, { namespace: 'config', scopeKey: tenantId });

// Inside a transaction — Postgres delivers at COMMIT and drops on ROLLBACK,
// so the message can never announce a write that rolled back. Failures throw.
await db.transaction(async (tx) => {
  await writeTheThing(tx);
  await invalidations.publishInTx(tx, { namespace: 'config', scopeKey: tenantId });
});

// Subscribe side — one listener per process, DIRECT connection string (same
// LISTEN constraints as the relay). onReconnect fires after a gap in which
// messages may have been lost: flush whatever the channel invalidates.
const sub = await invalidations.subscribe({
  connectionString: directDatabaseUrl,
  onMessage: ({ namespace, scopeKey }) => caches[namespace]?.invalidate(scopeKey),
  onReconnect: () => Object.values(caches).forEach((c) => c.clear()),
});
```

Contract details: both publish methods throw on schema/size violations
(programming errors). On database failure they diverge — that split is why
they're two named methods instead of one modal parameter: `publish` logs and
swallows (the hint is lost, the TTL backstop covers it), `publishInTx`
rethrows (a failed statement has aborted the transaction; the caller's
rollback handling must see it). Never hand a transaction context to
`publish` — its swallow semantics would mask the aborted transaction. Both
take a `DbOrTx` (the shared `drizzle/db` seam). `subscribe` throws on a
first-connect failure (boot-time misconfiguration fails loudly) and
reconnects automatically afterwards; schema-invalid payloads are dropped
silently, and a throwing `onMessage` is logged without taking the listener
down.

## Testing

`src/events/integration.test.ts` (Testcontainers) covers the properties mocks
cannot: append + NOTIFY at COMMIT, **rollback emits nothing** (the property
most likely to regress silently — assert it in your consumer too), LISTEN
kill → reconnect → catch-up, and scope isolation. The demo apps exercise the
full pipeline including the browser client (`apps/demo-server`
`routes/events.ts`, `apps/demo-web` `/events`).
`src/drizzle/broadcast/integration.test.ts` does the same for broadcast:
delivery to a live LISTEN, at-COMMIT semantics, rollback drops the message.
