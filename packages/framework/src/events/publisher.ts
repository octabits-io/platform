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
 */
import type { EventEnvelope, EventInput, EventOutboxStore } from './types.ts';
import { EVENT_ENVELOPE_SCHEMA } from './schema.ts';

export interface EventPublisher {
  /**
   * Emit one event. Durable events are appended to the outbox (returning the
   * assigned `seq` on the envelope); ephemeral events are sent inline.
   * Pass the surrounding transaction as `tx` whenever the emit accompanies a
   * state change.
   */
  emit<T>(input: EventInput<T>, tx?: unknown): Promise<EventEnvelope<T>>;
}

export interface CreateEventPublisherDeps {
  store: EventOutboxStore;
  /** Override id generation (default `crypto.randomUUID`). */
  generateId?: () => string;
  /** Override the clock (default `new Date().toISOString()`). */
  now?: () => string;
}

export function createEventPublisher(deps: CreateEventPublisherDeps): EventPublisher {
  const { store, generateId, now } = deps;

  async function emit<T>(input: EventInput<T>, tx?: unknown): Promise<EventEnvelope<T>> {
    const envelope: EventEnvelope<T> = {
      ...input,
      id: input.id ?? (generateId ? generateId() : crypto.randomUUID()),
      at: input.at ?? (now ? now() : new Date().toISOString()),
    };
    // Envelope validation failures are emit-site programming errors — throw.
    EVENT_ENVELOPE_SCHEMA.parse(envelope);

    if (envelope.lane === 'durable') {
      const { seq } = await store.append(envelope, tx);
      return { ...envelope, seq };
    }
    await store.notify(envelope, tx);
    return envelope;
  }

  return { emit };
}
