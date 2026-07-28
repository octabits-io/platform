/**
 * The bridge from the cross-process notification channel to the in-process
 * hub: decodes notifications, resolves durable pointers to outbox rows, and
 * keeps a per-scope watermark so missed or out-of-order notifications are
 * recovered from the outbox instead of lost.
 *
 * Ordering note (the bigserial gap): outbox `seq` values are assigned at
 * INSERT time but become visible in COMMIT order, so a pointer can arrive for
 * a `seq` at or below the current watermark (its transaction committed late).
 * The relay handles this by always reading from
 * `min(watermark, pointer.seq - 1)` — the late row is fetched and published,
 * already-delivered rows in between are re-published, and downstream dedupe
 * (the client keeps a seen-id set) absorbs the duplicates. At-least-once, by
 * design.
 *
 * The store reads run on whatever connection the injected store was built
 * with. The relay serializes its own reads (one at a time) so a store bound
 * to a single dedicated connection — the recommended setup for a
 * multi-scope reader — is safe.
 */
import type { Logger } from '../logger/index.ts';
import type { EventNotificationListener, EventOutboxStore } from './types.ts';
import type { EventHub } from './hub.ts';
import { decodeEventNotification } from './codec.ts';

export interface EventRelay {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateEventRelayDeps {
  hub: EventHub;
  store: Pick<EventOutboxStore, 'readSince'>;
  listener: EventNotificationListener;
  logger?: Logger;
  /** Max rows fetched per catch-up read (default 200). */
  batchLimit?: number;
}

export function createEventRelay(deps: CreateEventRelayDeps): EventRelay {
  const { hub, store, listener, logger, batchLimit = 200 } = deps;
  /** Highest seq published per scope, this process lifetime. */
  const watermarks = new Map<string, number>();
  /** Serializes store reads — see the module doc. */
  let readChain: Promise<void> = Promise.resolve();

  function enqueueRead(task: () => Promise<void>): void {
    readChain = readChain.then(task).catch((error) => {
      logger?.error('Event relay read failed', error instanceof Error ? error : undefined);
    });
  }

  async function publishFromOutbox(scopeKey: string, afterSeq: number): Promise<void> {
    let cursor = afterSeq;
    // Loop until a short page — a burst larger than batchLimit must not strand rows.
    for (;;) {
      const envelopes = await store.readSince(scopeKey, cursor, batchLimit);
      for (const envelope of envelopes) {
        hub.publish(envelope);
        if (envelope.seq !== undefined && envelope.seq > cursor) cursor = envelope.seq;
      }
      const current = watermarks.get(scopeKey) ?? -1;
      if (cursor > current) watermarks.set(scopeKey, cursor);
      if (envelopes.length < batchLimit) return;
    }
  }

  function onNotification(payload: string): void {
    const decoded = decodeEventNotification(payload);
    if (!decoded) return; // foreign traffic on a shared channel — ignore
    if (decoded.kind === 'event') {
      hub.publish(decoded.envelope);
      return;
    }
    // Durable pointer. Read from min(watermark, seq - 1) so a late-committing
    // row below the watermark is still fetched (bigserial gap, module doc).
    const { scopeKey, seq } = decoded;
    if (hub.subscriberCount(scopeKey) === 0) {
      // Nobody here for this scope — skip the read; clients replay via
      // Last-Event-ID when they connect.
      return;
    }
    const watermark = watermarks.get(scopeKey);
    const afterSeq = watermark === undefined ? seq - 1 : Math.min(watermark, seq - 1);
    enqueueRead(() => publishFromOutbox(scopeKey, afterSeq));
  }

  function onReconnect(): void {
    // Notifications sent while the listener was down are gone; catch up every
    // scope we were mid-stream on from its watermark.
    for (const scopeKey of hub.activeScopeKeys()) {
      const watermark = watermarks.get(scopeKey);
      if (watermark === undefined) continue;
      enqueueRead(() => publishFromOutbox(scopeKey, watermark));
    }
    logger?.info('Event relay reconnected; outbox catch-up scheduled', {
      scopes: hub.activeScopeKeys().length,
    });
  }

  return {
    start: () => listener.start({ onNotification, onReconnect }),
    stop: () => listener.stop(),
  };
}
