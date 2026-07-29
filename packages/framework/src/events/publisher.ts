/**
 * The one emit call site: validates the envelope, routes it to its lane, and
 * preserves the atomicity contract.
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const order = await createOrder(params, tx);
 *   await publisher.emit({
 *     type: 'order.created',
 *     scopeKey,
 *     lane: 'durable',
 *     data: { orderId: order.id },
 *   }, tx);
 * });
 * ```
 *
 * `emit` **throws** on failure — deliberately. Inside a transaction the throw
 * rolls the state change back, which is the whole guarantee: you can never
 * commit a write whose event was lost, and never announce a write that rolled
 * back (the notification fires at COMMIT). Do not wrap emit in a
 * try/catch-and-continue inside a transaction.
 *
 * Type safety is opt-in via {@link EventDataMap}: parameterize the publisher
 * with your event vocabulary (`createEventPublisher<MyEvents>(...)`) and
 * `emit` correlates `type` with its payload shape at compile time. Pass the
 * matching Zod schemas as `payloadSchemas` to enforce the same contract at
 * runtime. Both default off — an unparameterized publisher behaves exactly as
 * before (`type: string`, `data: unknown`).
 */
import type { ZodType } from 'zod';
import type { EventEnvelope, EventInput, EventOutboxStore } from './types.ts';
import { EVENT_ENVELOPE_SCHEMA } from './schema.ts';

/**
 * Consumer event vocabulary: event type string → payload shape. The framework
 * never knows the domain — consumers define this map (typically derived from
 * their Zod payload registry via `z.infer`) and parameterize the publisher.
 */
export type EventDataMap = Record<string, unknown>;

export interface EventPublisher<TMap extends EventDataMap = EventDataMap> {
  /**
   * Emit one event. Durable events are appended to the outbox (returning the
   * assigned `seq` on the envelope); ephemeral events are sent inline.
   * Pass the surrounding transaction as `tx` whenever the emit accompanies a
   * state change.
   *
   * With a parameterized publisher, `type` must be a key of the event map and
   * `data` must match that key's payload shape.
   */
  emit<K extends keyof TMap & string>(
    input: EventInput<TMap[K]> & { type: K },
    tx?: unknown,
  ): Promise<EventEnvelope<TMap[K]>>;
}

export interface CreateEventPublisherDeps {
  store: EventOutboxStore;
  /**
   * Per-type Zod payload validation, keyed by event type. When provided, the
   * registry is authoritative: emitting a type with no registered schema
   * throws, and a payload failing its schema throws — both are emit-site
   * programming errors, same stance as the envelope validation. Validation
   * only checks; it never strips, so consumer-merged extras on `data` (e.g.
   * an inline activity row) survive untouched.
   */
  payloadSchemas?: Readonly<Record<string, ZodType>>;
  /** Override id generation (default `crypto.randomUUID`). */
  generateId?: () => string;
  /** Override the clock (default `new Date().toISOString()`). */
  now?: () => string;
}

export function createEventPublisher<TMap extends EventDataMap = EventDataMap>(
  deps: CreateEventPublisherDeps,
): EventPublisher<TMap> {
  const { store, payloadSchemas, generateId, now } = deps;

  async function emit<K extends keyof TMap & string>(
    input: EventInput<TMap[K]> & { type: K },
    tx?: unknown,
  ): Promise<EventEnvelope<TMap[K]>> {
    const envelope: EventEnvelope<TMap[K]> = {
      ...input,
      id: input.id ?? (generateId ? generateId() : crypto.randomUUID()),
      at: input.at ?? (now ? now() : new Date().toISOString()),
    };
    // Envelope validation failures are emit-site programming errors — throw.
    EVENT_ENVELOPE_SCHEMA.parse(envelope);
    if (payloadSchemas) {
      const schema = payloadSchemas[envelope.type];
      if (!schema) {
        throw new Error(`No payload schema registered for event type "${envelope.type}"`);
      }
      schema.parse(envelope.data);
    }

    if (envelope.lane === 'durable') {
      const { seq } = await store.append(envelope, tx);
      return { ...envelope, seq };
    }
    await store.notify(envelope, tx);
    return envelope;
  }

  return { emit };
}
