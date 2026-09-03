/**
 * @octabits-io/framework/events/pglite — the LISTEN side of the event
 * notification channel for an **embedded** database: PGlite (WASM Postgres
 * running inside the process). Same `EventNotificationListener` contract as
 * `./events/postgres`, so the relay and the broadcast channel take either.
 *
 * Everything the network listener has to defend against is absent here —
 * there is no connection to drop, no pooler to bypass, no reconnect loop —
 * because the instance that NOTIFYs is the instance that listens. `NOTIFY`
 * inside a transaction is still delivered at COMMIT (PGlite is full
 * Postgres), so the outbox's "row + pointer atomically" guarantee holds.
 *
 * Structural on purpose: this file imports nothing from `@electric-sql/pglite`,
 * so the subpath adds no peer dependency — hand it the instance itself.
 */
import type { Logger } from '../logger/index.ts';
import type { EventNotificationListener } from './types.ts';

/**
 * The slice of a PGlite instance the listener uses: `listen(channel, cb)`
 * resolving to an unsubscribe function. A `PGlite` (or a `PGliteWorker`)
 * satisfies it as-is.
 */
export interface PgliteListenSource {
  listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
}

export interface CreatePgliteNotifyListenerDeps {
  /** The embedded database — the same instance the outbox store writes through. */
  pglite: PgliteListenSource;
  /**
   * Notification channel name. Must be a plain identifier
   * (`[A-Za-z_][A-Za-z0-9_]*`) — it is what `pg_notify(channel, …)` is called
   * with on the publish side.
   */
  channel: string;
  logger?: Logger;
}

const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * In-process LISTEN over an embedded PGlite instance. `onReconnect` never
 * fires: with no connection there is no gap to recover from.
 */
export function createPgliteNotifyListener(deps: CreatePgliteNotifyListenerDeps): EventNotificationListener {
  const { pglite, channel, logger } = deps;
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Invalid notification channel name '${channel}' — must match ${CHANNEL_PATTERN}`);
  }

  let unsubscribe: (() => Promise<void>) | undefined;

  return {
    async start(handlers) {
      if (unsubscribe) throw new Error(`Listener on '${channel}' is already started`);
      unsubscribe = await pglite.listen(channel, (payload) => handlers.onNotification(payload));
      logger?.info('Event listener attached to embedded database', { channel });
    },
    async stop() {
      const current = unsubscribe;
      unsubscribe = undefined;
      if (current) await current().catch(() => {});
    },
  };
}
