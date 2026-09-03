/**
 * Core types for the events module: the envelope, the two delivery lanes, and
 * the structural seams the other pieces plug into.
 *
 * Two lanes, one envelope:
 *
 * - **durable** — appended to a consumer-owned outbox table in the same
 *   transaction as the state change it describes, then announced via a
 *   pointer notification. At-least-once, replayable by `seq` watermark.
 * - **ephemeral** — never persisted; the full envelope rides the notification
 *   payload inline. Best-effort, fire-and-forget; a subscriber that missed one
 *   re-syncs from current state instead of replaying.
 *
 * The seams ({@link EventOutboxStore}, {@link EventNotificationListener}) are
 * structural on purpose: the Drizzle/Postgres implementations live in their
 * own subpaths (`drizzle/event-outbox`, `events/postgres`) so this module
 * stays free of database dependencies.
 */

/** Delivery lane — see the module doc above. */
export type EventLane = 'durable' | 'ephemeral';

/**
 * Who or what caused the event. `type` is a plain string — consumers narrow it
 * to their own actor union (e.g. `'admin' | 'system' | 'customer' | 'ai'`).
 */
export interface EventActor {
  type: string;
  id?: string;
  name?: string;
}

/**
 * Delivery targeting, evaluated per subscriber at fan-out time.
 *
 * - `users` — restrict delivery to these subscriber ids. Omit for a
 *   scope-wide event.
 * - `permission` — an opaque requirement evaluated by the subscriber's
 *   `can(...)` predicate (the permission model stays consumer-side). When a
 *   permission is present and the subscriber has no evaluator, delivery
 *   **fails closed**.
 *
 * Both filters apply (AND). An event with neither is delivered to every
 * subscriber of its scope.
 */
export interface EventAudience {
  users?: string[];
  permission?: unknown;
}

/** The wire envelope — one shape for both lanes. */
export interface EventEnvelope<T = unknown> {
  /** Opaque, globally unique. The client-side dedupe key. */
  id: string;
  /**
   * Monotonic per outbox (bigserial). Durable lane only — assigned at append
   * time; this is the replay watermark. Ephemeral events never carry one.
   */
  seq?: number;
  /** Dotted, versioned type taxonomy (consumer vocabulary), e.g. `order.created`. */
  type: string;
  /** The scope this event belongs to (e.g. a tenant id). Fan-out filter key. */
  scopeKey: string;
  /** Emission time (server clock, ISO-8601). */
  at: string;
  /** Delivery lane. */
  lane: EventLane;
  /** Domain payload. Keep it small — identifiers, not entities. */
  data: T;
  /** Who/what caused the event. */
  actor?: EventActor;
  /** Delivery targeting — omit for scope-wide broadcast. */
  audience?: EventAudience;
  /**
   * Opaque resource keys this event touched (e.g. `booking:412`) — the
   * client-side invalidation hook. Convention is consumer-owned.
   */
  resources?: string[];
}

/** What a caller passes to `emit` — `id`/`at` are optional (defaulted), `seq` is server-assigned. */
export type EventInput<T = unknown> = Omit<EventEnvelope<T>, 'id' | 'at' | 'seq'> & {
  id?: string;
  at?: string;
};

/**
 * Structural seam over the consumer-owned outbox table + notification send.
 * Implemented by `@octabits-io/framework/drizzle/event-outbox`.
 *
 * All methods **throw** on failure rather than returning a `Result`: `append`
 * runs inside the caller's state-change transaction, and the throw is what
 * makes the atomicity guarantee hold — an event that cannot be recorded must
 * fail the write it describes.
 */
export interface EventOutboxStore {
  /**
   * Durable lane: insert the envelope as an outbox row AND send the pointer
   * notification **within the same transaction** (`tx`), so both fire at
   * COMMIT or not at all. Returns the assigned `seq`.
   */
  append(envelope: EventEnvelope, tx?: unknown): Promise<{ seq: number }>;
  /**
   * Ephemeral lane: send the full envelope inline as a notification. No row.
   * Pass `tx` to defer the send to COMMIT (recommended when emitting next to
   * writes); omit it for a standalone fire-and-forget signal.
   */
  notify(envelope: EventEnvelope, tx?: unknown): Promise<void>;
  /** Read durable envelopes with `seq > afterSeq` for a scope, oldest first. */
  readSince(scopeKey: string, afterSeq: number, limit?: number): Promise<EventEnvelope[]>;
  /** Delete durable rows older than `before`. Returns the number removed. */
  prune(before: Date): Promise<number>;
}

/**
 * Structural seam over the cross-process notification channel's receive side.
 * Implemented by `@octabits-io/framework/events/postgres` (LISTEN/NOTIFY over a
 * dedicated connection) and `…/events/pglite` (in-process, embedded database).
 */
export interface EventNotificationListener {
  /**
   * Open the channel and deliver raw payloads to `onNotification`.
   * `onReconnect` fires after the channel is re-established following a drop
   * — the relay uses it to trigger a catch-up read, because notifications
   * sent while the listener was down are gone.
   */
  start(handlers: {
    onNotification: (payload: string) => void;
    onReconnect?: () => void;
  }): Promise<void>;
  stop(): Promise<void>;
}
