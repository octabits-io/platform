/**
 * @octabits-io/framework/drizzle/broadcast — a minimal cross-process
 * broadcast channel over Postgres NOTIFY, for fire-and-forget coordination
 * signals between processes sharing one database: cache invalidation hints,
 * "reload X" pokes, and similar. Deliberately **not** part of the
 * `events` taxonomy: no envelope, no outbox, no audience/permission
 * filtering, no SSE delivery — a broadcast message is a hint, not a fact.
 *
 * Delivery is at-most-once and best-effort by design. NOTIFY reaches only
 * processes currently listening; there is no replay for a process that was
 * down or reconnecting. Every consumer therefore needs an independent
 * correctness backstop (typically a TTL on whatever the broadcast
 * invalidates) — the channel only shortens the staleness window, it never
 * carries state.
 *
 * The LISTEN side reuses `events/postgres`' dedicated-connection listener,
 * inheriting its deployment constraints: subscribe with a **direct**
 * (non-pooled, non-PgBouncer) connection string. The publish side is one
 * `pg_notify(...)` on the consumer's regular Drizzle connection — pooled is
 * fine. Two publish methods with distinct contracts:
 *
 * - {@link BroadcastChannel.publish} — best-effort hint on a regular
 *   connection; database failures are logged, never thrown.
 * - {@link BroadcastChannel.publishInTx} — inside a transaction; Postgres
 *   delivers at COMMIT (an invalidate-after-write can never announce a
 *   write that rolled back), and database failures throw.
 *
 * This subpath pulls in the `drizzle-orm` and (via the listener) `pg`
 * optional peers.
 */
import { sql } from 'drizzle-orm';
import type { ZodType } from 'zod';
import type { Logger } from '../../logger/index.ts';
import type { DbOrTx } from '../db/index.ts';
import { MAX_NOTIFY_PAYLOAD_BYTES } from '../../events/codec.ts';
import { createPgNotifyListener } from '../../events/postgres.ts';
import type { EventNotificationListener } from '../../events/types.ts';

export type { DbOrTx } from '../db/index.ts';

const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CreateBroadcastChannelDeps<T> {
  /**
   * Notification channel name. Must be a plain identifier
   * (`[A-Za-z_][A-Za-z0-9_]*`); shared with nothing else unless every party
   * tolerates the other's payloads (invalid payloads are ignored on receive).
   */
  channel: string;
  /**
   * Payload contract, enforced on both ends: `publish` throws on a payload
   * failing the schema (emit-site programming error, same stance as the
   * event publisher); `subscribe` silently drops non-conforming payloads
   * (the wire is shared infrastructure, not a trusted caller).
   */
  schema: ZodType<T>;
  logger?: Logger;
  /**
   * Listener factory override (tests). Defaults to
   * `events/postgres`' `createPgNotifyListener`.
   */
  createListener?: (deps: {
    connectionString: string;
    channel: string;
    logger?: Logger;
  }) => EventNotificationListener;
}

export interface BroadcastSubscribeOptions<T> {
  /** Direct (non-pooled, non-PgBouncer) connection string — LISTEN requirement. */
  connectionString: string;
  /**
   * Called once per received, schema-valid message. Exceptions are caught
   * and logged — a faulty handler must not take the listener down.
   */
  onMessage: (payload: T) => void;
  /**
   * Called after the underlying connection reconnects. Anything broadcast
   * during the gap was lost (at-most-once, no replay) — a cache-invalidation
   * consumer should flush whatever the channel invalidates.
   */
  onReconnect?: () => void;
}

export interface BroadcastSubscription {
  stop(): Promise<void>;
}

export interface BroadcastChannel<T> {
  /**
   * Best-effort: send one message on a regular (pooled OK) connection.
   * Schema/size violations throw (publish-site programming errors);
   * database failures are logged and swallowed — a lost hint degrades to
   * the consumer's TTL backstop, which must exist by contract. Safe to
   * `void`-discard.
   *
   * Do NOT call this with a transaction context — inside a transaction a
   * failed statement aborts the whole tx, and swallowing the error here
   * would surface as confusing downstream failures. Use
   * {@link publishInTx} instead.
   */
  publish(db: DbOrTx, payload: T): Promise<void>;
  /**
   * Publish as part of a transaction: Postgres delivers the notification
   * at COMMIT and drops it on ROLLBACK, so the message can never announce
   * a write that rolled back. Schema/size violations AND database
   * failures throw — the transaction is aborted regardless, and the
   * caller's rollback handling must see the error.
   */
  publishInTx(tx: DbOrTx, payload: T): Promise<void>;
  /**
   * Start listening. Resolves once the LISTEN is registered; throws on a
   * first-connect failure (boot-time misconfiguration must fail loudly —
   * same stance as the events listener). Reconnects automatically afterwards.
   */
  subscribe(options: BroadcastSubscribeOptions<T>): Promise<BroadcastSubscription>;
}

export function createBroadcastChannel<T>(deps: CreateBroadcastChannelDeps<T>): BroadcastChannel<T> {
  const { channel, schema, logger, createListener = createPgNotifyListener } = deps;
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Invalid broadcast channel name '${channel}' — must match ${CHANNEL_PATTERN}`);
  }

  /** Validation failures are publish-site programming errors — throw. */
  function encodePayload(payload: T): string {
    const parsed = schema.parse(payload);
    const encoded = JSON.stringify(parsed);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > MAX_NOTIFY_PAYLOAD_BYTES) {
      throw new Error(
        `Broadcast payload on '${channel}' encodes to ${bytes} bytes, over the ` +
          `${MAX_NOTIFY_PAYLOAD_BYTES}-byte notification limit. Broadcast payloads ` +
          'must stay small (identifiers, not entities).',
      );
    }
    return encoded;
  }

  async function publish(db: DbOrTx, payload: T): Promise<void> {
    const encoded = encodePayload(payload);
    try {
      await db.execute(sql`select pg_notify(${channel}, ${encoded})`);
    } catch (error) {
      logger?.warn('Broadcast publish failed; subscribers fall back to their TTL backstop', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function publishInTx(tx: DbOrTx, payload: T): Promise<void> {
    const encoded = encodePayload(payload);
    // No catch: a failed statement has aborted the transaction — the error
    // must reach the caller's rollback handling.
    await tx.execute(sql`select pg_notify(${channel}, ${encoded})`);
  }

  async function subscribe(options: BroadcastSubscribeOptions<T>): Promise<BroadcastSubscription> {
    const listener = createListener({
      connectionString: options.connectionString,
      channel,
      logger,
    });

    await listener.start({
      onNotification: (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          logger?.debug('Ignoring non-JSON broadcast payload', { channel });
          return;
        }
        const result = schema.safeParse(parsed);
        if (!result.success) {
          logger?.debug('Ignoring schema-invalid broadcast payload', { channel });
          return;
        }
        try {
          options.onMessage(result.data);
        } catch (error) {
          logger?.error(
            'Broadcast onMessage handler threw',
            error instanceof Error ? error : undefined,
            { channel },
          );
        }
      },
      onReconnect: options.onReconnect,
    });

    return { stop: () => listener.stop() };
  }

  return { publish, publishInTx, subscribe };
}
