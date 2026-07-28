/**
 * @octabits-io/framework/events/postgres — the LISTEN side of the event
 * notification channel: one dedicated, long-lived Postgres connection per
 * process, with automatic reconnect and a reconnect hook the relay uses to
 * trigger outbox catch-up.
 *
 * Deployment constraints this encodes (learned the hard way with pg-boss):
 *
 * - **A dedicated connection, never a pooled one.** Pools reset connections
 *   between checkouts, silently dropping the LISTEN registration — the
 *   channel then looks healthy and delivers nothing.
 * - **Bypass transaction-mode poolers (PgBouncer).** LISTEN does not survive
 *   transaction pooling; use the direct database URL, exactly as pg-boss
 *   requires.
 *
 * `pg` is an optional peer confined to this subpath — importing
 * `@octabits-io/framework/events` alone never pulls it in.
 */
import pg from 'pg';
import type { Logger } from '../logger/index.ts';
import type { EventNotificationListener } from './types.ts';

export interface CreatePgNotifyListenerDeps {
  /** Direct (non-pooled, non-PgBouncer) connection string. */
  connectionString: string;
  /**
   * Notification channel name. Must be a plain identifier
   * (`[A-Za-z_][A-Za-z0-9_]*`) — it is interpolated into `LISTEN` as an
   * identifier and cannot be parameterized.
   */
  channel: string;
  logger?: Logger;
  /** Initial reconnect delay (default 1 000 ms), doubled per attempt with jitter. */
  reconnectDelayMs?: number;
  /** Reconnect delay ceiling (default 30 000 ms). */
  maxReconnectDelayMs?: number;
}

const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createPgNotifyListener(deps: CreatePgNotifyListenerDeps): EventNotificationListener {
  const { connectionString, channel, logger, reconnectDelayMs = 1_000, maxReconnectDelayMs = 30_000 } = deps;
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Invalid notification channel name '${channel}' — must match ${CHANNEL_PATTERN}`);
  }

  let client: pg.Client | undefined;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  async function start(handlers: {
    onNotification: (payload: string) => void;
    onReconnect?: () => void;
  }): Promise<void> {
    stopped = false;

    async function connect(isReconnect: boolean): Promise<void> {
      if (stopped) return;
      const next = new pg.Client({ connectionString });
      client = next;

      const scheduleReconnect = () => {
        if (stopped || client !== next) return;
        client = undefined;
        void next.end().catch(() => {});
        attempt += 1;
        // Full jitter: a synchronized drop must not produce a synchronized
        // reconnect stampede against the database.
        const cap = Math.min(maxReconnectDelayMs, reconnectDelayMs * 2 ** Math.min(attempt, 10));
        const delay = Math.random() * cap;
        logger?.warn('Event listener connection lost; reconnecting', {
          channel,
          attempt,
          delayMs: Math.round(delay),
        });
        reconnectTimer = setTimeout(() => void connect(true), delay);
      };

      next.on('notification', (message) => {
        handlers.onNotification(message.payload ?? '');
      });
      next.on('error', scheduleReconnect);
      next.on('end', scheduleReconnect);

      try {
        await next.connect();
        await next.query(`LISTEN "${channel}"`);
      } catch (error) {
        if (isReconnect || attempt > 0) {
          // Mid-life reconnect failure: keep retrying.
          scheduleReconnect();
          return;
        }
        // First connect: fail loudly — a boot-time misconfiguration must not
        // degrade into a silent retry loop nobody notices.
        client = undefined;
        void next.end().catch(() => {});
        throw error;
      }

      attempt = 0;
      if (isReconnect) {
        logger?.info('Event listener reconnected', { channel });
        handlers.onReconnect?.();
      } else {
        logger?.info('Event listener connected', { channel });
      }
    }

    await connect(false);
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const current = client;
    client = undefined;
    if (current) await current.end().catch(() => {});
  }

  return { start, stop };
}
