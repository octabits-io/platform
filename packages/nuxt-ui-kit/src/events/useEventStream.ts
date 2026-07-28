/**
 * Vue composable over {@link createEventStreamClient}: reactive connection
 * state, scope-bound lifecycle, and a typed per-event-type handler registry.
 *
 * The app owns *what to do* with events (invalidation registry, toasts, …);
 * this composable owns the connection. Typical wiring, once, in the app
 * shell:
 *
 * ```ts
 * const stream = useEventStream({
 *   buildRequest: () => ({
 *     url: `${apiBase}/events`,
 *     headers: { authorization: `Bearer ${auth.accessToken}` },
 *   }),
 *   onEvent: (event) => invalidation.dispatch(event),
 * });
 * watch(tenantReady, (ready) => (ready ? stream.start() : stream.stop()));
 * ```
 */
import { onScopeDispose, readonly, ref, type Ref } from 'vue';
import {
  createEventStreamClient,
  type EventStreamClientOptions,
  type EventStreamState,
  type StreamedEvent,
} from './client.ts';

export interface UseEventStreamReturn {
  /** Reactive connection state — drive fallback-polling and UI hints off this. */
  state: Readonly<Ref<EventStreamState>>;
  /** Reactive count of events delivered (deduped) this session. */
  received: Readonly<Ref<number>>;
  start(): void;
  stop(): void;
  /** Current watermark (persist it to resume replay across page loads). */
  lastEventId(): string | null;
}

export function useEventStream(options: EventStreamClientOptions): UseEventStreamReturn {
  const state = ref('idle') as Ref<EventStreamState>;
  const received = ref(0) as Ref<number>;

  const client = createEventStreamClient({
    ...options,
    onEvent: (event: StreamedEvent) => {
      received.value += 1;
      options.onEvent(event);
    },
    onStateChange: (next) => {
      state.value = next;
      options.onStateChange?.(next);
    },
  });

  onScopeDispose(() => client.stop());

  return {
    state: readonly(state) as Readonly<Ref<EventStreamState>>,
    received: readonly(received) as Readonly<Ref<number>>,
    start: client.start,
    stop: client.stop,
    lastEventId: client.lastEventId,
  };
}
