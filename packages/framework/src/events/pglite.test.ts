import { describe, it, expect, vi } from 'vitest';
import { createPgliteNotifyListener } from './pglite.ts';

/** A PGlite stand-in: records subscriptions, lets the test fire notifications. */
function fakePglite() {
  const channels = new Map<string, Set<(payload: string) => void>>();
  const unsubscribed: string[] = [];
  return {
    channels,
    unsubscribed,
    async listen(channel: string, callback: (payload: string) => void) {
      const set = channels.get(channel) ?? new Set();
      set.add(callback);
      channels.set(channel, set);
      return async () => {
        set.delete(callback);
        unsubscribed.push(channel);
      };
    },
    notify(channel: string, payload: string) {
      for (const cb of channels.get(channel) ?? []) cb(payload);
    },
  };
}

describe('createPgliteNotifyListener', () => {
  it('delivers payloads from the embedded instance and unsubscribes on stop', async () => {
    const pglite = fakePglite();
    const listener = createPgliteNotifyListener({ pglite, channel: 'app_events' });
    const onNotification = vi.fn();
    const onReconnect = vi.fn();

    await listener.start({ onNotification, onReconnect });
    pglite.notify('app_events', '{"seq":1}');
    pglite.notify('other', 'ignored');
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith('{"seq":1}');
    // No connection ⇒ no drop ⇒ no reconnect, ever.
    expect(onReconnect).not.toHaveBeenCalled();

    await listener.stop();
    pglite.notify('app_events', 'after stop');
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(pglite.unsubscribed).toEqual(['app_events']);
    // Idempotent.
    await listener.stop();
    expect(pglite.unsubscribed).toEqual(['app_events']);
  });

  it('refuses a double start and an unsafe channel name', async () => {
    const pglite = fakePglite();
    const listener = createPgliteNotifyListener({ pglite, channel: 'app_events' });
    await listener.start({ onNotification: () => {} });
    await expect(listener.start({ onNotification: () => {} })).rejects.toThrow(/already started/);
    expect(() => createPgliteNotifyListener({ pglite, channel: 'bad-name' })).toThrow(/Invalid notification channel/);
  });
});
