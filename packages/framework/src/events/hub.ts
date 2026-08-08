/**
 * The in-process fan-out hub: subscribers register per scope, envelopes are
 * published to every matching subscriber. Purely in-memory — one hub per
 * process, fed by an {@link createEventRelay | event relay}; subscribers hold
 * no database handle.
 *
 * Filtering happens **server-side, per subscriber, at delivery time**:
 *
 * 1. scope match (`envelope.scopeKey === subscriber.scopeKey`)
 * 2. personal audience (`audience.users` must include the subscriber id)
 * 3. the subscriber's own `authorize` predicate (where the consumer evaluates
 *    `audience.permission` against live grants)
 *
 * A subscriber callback that throws is logged and skipped — one broken
 * consumer must never break fan-out for the rest.
 */
import type { Logger } from '../logger/index.ts';
import type { EventEnvelope } from './types.ts';

export interface EventHubSubscriber {
  /** Scope this subscriber receives events for. */
  scopeKey: string;
  /** Identity used for `audience.users` targeting and connection accounting. */
  subscriberId: string;
  /**
   * Per-envelope delivery gate — evaluate `envelope.audience.permission`
   * against this subscriber's grants here. Return `false` to skip delivery.
   * When an envelope carries a permission and no `authorize` is provided,
   * delivery **fails closed**.
   */
  authorize?: (envelope: EventEnvelope) => boolean;
  /** Delivery callback. Must not throw; if it does, the error is logged and contained. */
  onEvent: (envelope: EventEnvelope) => void;
}

export interface PublishStats {
  /** Subscribers the envelope was delivered to. */
  delivered: number;
  /** Subscribers skipped by audience/authorize filtering. */
  filtered: number;
}

export interface EventHub {
  /** Register a subscriber. Returns the unsubscribe function. */
  subscribe(subscriber: EventHubSubscriber): () => void;
  /** Fan an envelope out to every matching subscriber of its scope. */
  publish(envelope: EventEnvelope): PublishStats;
  /** Scopes that currently have at least one subscriber (relay catch-up set). */
  activeScopeKeys(): string[];
  /** Subscriber count — total, per scope, or per (scope, subscriber id). */
  subscriberCount(scopeKey?: string, subscriberId?: string): number;
}

export interface CreateEventHubDeps {
  logger?: Logger;
}

/**
 * The delivery gate: personal targeting (`audience.users`) AND the subscriber's
 * `authorize` predicate, both applied, fail-closed on a permission with no
 * evaluator.
 *
 * Exported and shared on purpose. A replay source (the SSE handler's
 * `Last-Event-ID` catch-up) reads envelopes straight out of the outbox and
 * never passes through {@link EventHub.publish}, so it must run the *same*
 * check — a second, hand-written copy of the rule is exactly how the replay
 * path came to drop the `audience.users` filter and deliver user-targeted
 * events to every subscriber in the scope.
 */
export function isEnvelopePermitted(
  envelope: EventEnvelope,
  subscriber: Pick<EventHubSubscriber, 'subscriberId' | 'authorize'>,
): boolean {
  const audience = envelope.audience;
  if (audience?.users && !audience.users.includes(subscriber.subscriberId)) return false;
  if (subscriber.authorize) return subscriber.authorize(envelope);
  // No authorize predicate: fail closed if the envelope demands a permission.
  return audience?.permission === undefined;
}

export function createEventHub(deps: CreateEventHubDeps = {}): EventHub {
  const { logger } = deps;
  const byScope = new Map<string, Set<EventHubSubscriber>>();

  function subscribe(subscriber: EventHubSubscriber): () => void {
    const existing = byScope.get(subscriber.scopeKey);
    const set = existing ?? new Set<EventHubSubscriber>();
    if (!existing) byScope.set(subscriber.scopeKey, set);
    set.add(subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size === 0 && byScope.get(subscriber.scopeKey) === set) {
        byScope.delete(subscriber.scopeKey);
      }
    };
  }

  function publish(envelope: EventEnvelope): PublishStats {
    const stats: PublishStats = { delivered: 0, filtered: 0 };
    const set = byScope.get(envelope.scopeKey);
    if (!set) return stats;
    // Snapshot: a subscriber may unsubscribe from within its own callback.
    for (const subscriber of [...set]) {
      if (!isEnvelopePermitted(envelope, subscriber)) {
        stats.filtered += 1;
        continue;
      }
      try {
        subscriber.onEvent(envelope);
        stats.delivered += 1;
      } catch (error) {
        stats.filtered += 1;
        logger?.error('Event subscriber callback threw', error instanceof Error ? error : undefined, {
          scopeKey: subscriber.scopeKey,
          subscriberId: subscriber.subscriberId,
          eventType: envelope.type,
          eventId: envelope.id,
        });
      }
    }
    return stats;
  }

  function activeScopeKeys(): string[] {
    return [...byScope.keys()];
  }

  function subscriberCount(scopeKey?: string, subscriberId?: string): number {
    if (scopeKey === undefined) {
      let total = 0;
      for (const set of byScope.values()) total += set.size;
      return total;
    }
    const set = byScope.get(scopeKey);
    if (!set) return 0;
    if (subscriberId === undefined) return set.size;
    let count = 0;
    for (const subscriber of set) if (subscriber.subscriberId === subscriberId) count += 1;
    return count;
  }

  return { subscribe, publish, activeScopeKeys, subscriberCount };
}
