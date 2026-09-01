// `onScopeDispose` needs an owning component instance.
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';

/**
 * `useEventStream` is the Vue skin over `createEventStreamClient`: the client's
 * own behaviour (watermark, dedupe, reconnect) is proven in `events.test.ts`
 * against a scripted fetch, so this mocks the client and covers what only the
 * composable does — mirror the state into refs, count deliveries, keep the
 * caller's handlers, and stop the connection when the scope goes away.
 */
const { createEventStreamClient, clientStub, captured } = vi.hoisted(() => {
  const captured: { options?: Record<string, unknown> } = {};
  const clientStub = {
    start: vi.fn(),
    stop: vi.fn(),
    lastEventId: vi.fn().mockReturnValue('42'),
  };
  const createEventStreamClient = vi.fn((options: Record<string, unknown>) => {
    captured.options = options;
    return clientStub;
  });
  return { createEventStreamClient, clientStub, captured };
});

vi.mock('./client.ts', () => ({ createEventStreamClient }));

import { useEventStream } from './useEventStream.ts';
import type { StreamedEvent } from './client.ts';

const event = (id: string): StreamedEvent => ({
  id,
  type: 'order.created',
  scopeKey: 'scope-a',
  at: '2026-08-31T00:00:00.000Z',
  lane: 'ephemeral',
  data: {},
});

function mountStream(options: Parameters<typeof useEventStream>[0]) {
  let exposed!: ReturnType<typeof useEventStream>;
  const wrapper = mount(
    defineComponent({
      setup() {
        exposed = useEventStream(options);
        return () => h('div');
      },
    }),
  );
  return { stream: exposed, wrapper };
}

describe('useEventStream', () => {
  it('starts idle and delegates start/stop/lastEventId to the client', () => {
    const { stream } = mountStream({ buildRequest: () => ({ url: '/events' }), onEvent: vi.fn() });

    expect(stream.state.value).toBe('idle');
    stream.start();
    expect(clientStub.start).toHaveBeenCalled();
    stream.stop();
    expect(clientStub.stop).toHaveBeenCalled();
    expect(stream.lastEventId()).toBe('42');
  });

  it('counts deliveries and still calls the caller’s onEvent', () => {
    const onEvent = vi.fn();
    const { stream } = mountStream({ buildRequest: () => ({ url: '/events' }), onEvent });

    const deliver = captured.options!.onEvent as (e: StreamedEvent) => void;
    deliver(event('1'));
    deliver(event('2'));

    expect(stream.received.value).toBe(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith(event('2'));
  });

  it('mirrors connection state into the ref and forwards it to the caller', () => {
    const onStateChange = vi.fn();
    const { stream } = mountStream({
      buildRequest: () => ({ url: '/events' }),
      onEvent: vi.fn(),
      onStateChange,
    });

    const change = captured.options!.onStateChange as (s: string) => void;
    change('open');
    expect(stream.state.value).toBe('open');
    change('degraded');
    expect(stream.state.value).toBe('degraded');
    expect(onStateChange).toHaveBeenNthCalledWith(2, 'degraded');
  });

  it('stops the connection when the owning scope is disposed', () => {
    const { wrapper } = mountStream({ buildRequest: () => ({ url: '/events' }), onEvent: vi.fn() });
    clientStub.stop.mockClear();

    wrapper.unmount();

    // Otherwise a route change leaves an SSE connection open per visit.
    expect(clientStub.stop).toHaveBeenCalledOnce();
  });
});
