import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createBroadcastChannel, type BroadcastDatabase } from './index.ts';
import type { EventNotificationListener } from '../../events/types.ts';

const PAYLOAD_SCHEMA = z.object({
  namespace: z.string(),
  tenantId: z.string(),
});
type Payload = z.infer<typeof PAYLOAD_SCHEMA>;

function makeFakeDb(behavior?: (query: unknown) => Promise<unknown>) {
  const execute = vi.fn(behavior ?? (async (_query: unknown) => []));
  const db: BroadcastDatabase = { execute };
  return { db, execute };
}

/** A listener fake that captures handlers and lets tests fire notifications. */
function makeFakeListener() {
  let handlers: { onNotification: (payload: string) => void; onReconnect?: () => void } | undefined;
  const stop = vi.fn(async () => {});
  const listener: EventNotificationListener = {
    start: async (h) => {
      handlers = h;
    },
    stop,
  };
  return {
    listener,
    stop,
    fire: (payload: string) => handlers!.onNotification(payload),
    reconnect: () => handlers!.onReconnect?.(),
  };
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
}

describe('createBroadcastChannel', () => {
  it('rejects an invalid channel name', () => {
    expect(() =>
      createBroadcastChannel({ channel: 'bad-channel;drop', schema: PAYLOAD_SCHEMA }),
    ).toThrow(/Invalid broadcast channel name/);
  });

  describe('publish', () => {
    it('sends one pg_notify per publish', async () => {
      const channel = createBroadcastChannel({ channel: 'test_channel', schema: PAYLOAD_SCHEMA });
      const { db, execute } = makeFakeDb();
      await channel.publish(db, { namespace: 'tenant-config', tenantId: 't1' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]![0]).toBeDefined();
    });

    it('throws on a payload failing the schema (publish-site programming error)', async () => {
      const channel = createBroadcastChannel({ channel: 'test_channel', schema: PAYLOAD_SCHEMA });
      const { db, execute } = makeFakeDb();
      await expect(
        channel.publish(db, { namespace: 'tenant-config' } as unknown as Payload),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    });

    it('throws on an oversized payload', async () => {
      const channel = createBroadcastChannel({ channel: 'test_channel', schema: PAYLOAD_SCHEMA });
      const { db, execute } = makeFakeDb();
      await expect(
        channel.publish(db, { namespace: 'tenant-config', tenantId: 'x'.repeat(8000) }),
      ).rejects.toThrow(/notification limit/);
      expect(execute).not.toHaveBeenCalled();
    });

    it('swallows database failures outside a transaction (TTL backstop takes over)', async () => {
      const logger = makeLogger();
      const channel = createBroadcastChannel({
        channel: 'test_channel',
        schema: PAYLOAD_SCHEMA,
        logger,
      });
      const { db } = makeFakeDb(async () => {
        throw new Error('connection refused');
      });
      await expect(
        channel.publish(db, { namespace: 'tenant-config', tenantId: 't1' }),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('rethrows database failures when a tx is passed (the tx is aborted anyway)', async () => {
      const channel = createBroadcastChannel({ channel: 'test_channel', schema: PAYLOAD_SCHEMA });
      const { db } = makeFakeDb();
      const { db: tx } = makeFakeDb(async () => {
        throw new Error('current transaction is aborted');
      });
      await expect(
        channel.publish(db, { namespace: 'tenant-config', tenantId: 't1' }, tx),
      ).rejects.toThrow(/aborted/);
    });
  });

  describe('subscribe', () => {
    function makeSubscribed() {
      const fake = makeFakeListener();
      const logger = makeLogger();
      const channel = createBroadcastChannel({
        channel: 'test_channel',
        schema: PAYLOAD_SCHEMA,
        logger,
        createListener: () => fake.listener,
      });
      const onMessage = vi.fn();
      return { fake, logger, channel, onMessage };
    }

    it('delivers schema-valid messages to onMessage', async () => {
      const { fake, channel, onMessage } = makeSubscribed();
      await channel.subscribe({ connectionString: 'postgres://direct', onMessage });
      fake.fire(JSON.stringify({ namespace: 'tenant-config', tenantId: 't1' }));
      expect(onMessage).toHaveBeenCalledWith({ namespace: 'tenant-config', tenantId: 't1' });
    });

    it('ignores non-JSON and schema-invalid payloads', async () => {
      const { fake, channel, onMessage } = makeSubscribed();
      await channel.subscribe({ connectionString: 'postgres://direct', onMessage });
      fake.fire('not-json');
      fake.fire(JSON.stringify({ unrelated: true }));
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('a throwing handler is logged and does not stop later deliveries', async () => {
      const { fake, logger, channel, onMessage } = makeSubscribed();
      onMessage.mockImplementationOnce(() => {
        throw new Error('handler bug');
      });
      await channel.subscribe({ connectionString: 'postgres://direct', onMessage });
      fake.fire(JSON.stringify({ namespace: 'tenant-config', tenantId: 't1' }));
      fake.fire(JSON.stringify({ namespace: 'tenant-config', tenantId: 't2' }));
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledTimes(2);
    });

    it('wires onReconnect through and stop() stops the listener', async () => {
      const { fake, channel, onMessage } = makeSubscribed();
      const onReconnect = vi.fn();
      const sub = await channel.subscribe({
        connectionString: 'postgres://direct',
        onMessage,
        onReconnect,
      });
      fake.reconnect();
      expect(onReconnect).toHaveBeenCalledTimes(1);
      await sub.stop();
      expect(fake.stop).toHaveBeenCalledTimes(1);
    });
  });
});
