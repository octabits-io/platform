/**
 * The fetch-based SSE event-stream client. A hand-rolled reader rather than
 * native `EventSource` because the stream is authenticated with an
 * `Authorization` header, which `new EventSource(url)` cannot set — so
 * reconnect, `Last-Event-ID`, and backoff are implemented here, once.
 *
 * Semantics baked in (mirroring the server contract in
 * `@octabits-io/framework/events`):
 *
 * - **Watermark**: only frames carrying an SSE `id:` advance the persisted
 *   watermark (the server sets `id:` on durable events only) — sent back as
 *   the `Last-Event-ID` header on every reconnect for replay.
 * - **Dedupe**: replay overlaps and at-least-once delivery mean duplicates
 *   are normal; a bounded seen-id set (envelope `id`, not `seq`) filters
 *   them before `onEvent`.
 * - **Reconnect is routine, not an error**: the server caps connection age
 *   (~5 min) so auth is re-evaluated; a server-side close re-connects after
 *   the server's `retry:` hint with **full jitter**. Only sustained failure
 *   moves the state to `degraded` (UI hint to resume fallback polling).
 */
import { createSseFrameParser } from './sseParser.ts';

/**
 * Structural duplicate of the framework's `EventEnvelope` — the kit has no
 * dependency on `@octabits-io/framework`, and the wire format is the
 * contract, not the type.
 */
export interface StreamedEvent<T = unknown> {
  id: string;
  seq?: number;
  type: string;
  scopeKey: string;
  at: string;
  lane: 'durable' | 'ephemeral';
  data: T;
  actor?: { type: string; id?: string; name?: string };
  resources?: string[];
}

export type EventStreamState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'stopped';

export interface EventStreamRequest {
  url: string;
  /** Extra headers — put your `Authorization` here, fresh per attempt. */
  headers?: Record<string, string>;
}

export interface EventStreamClientOptions {
  /**
   * Build the request for each (re)connect attempt. Called every attempt so
   * the auth token is always fresh. May be async (token refresh).
   */
  buildRequest: () => EventStreamRequest | Promise<EventStreamRequest>;
  /** Deduped envelope delivery, both lanes. */
  onEvent: (event: StreamedEvent) => void;
  onStateChange?: (state: EventStreamState) => void;
  /** Injected fetch (default `globalThis.fetch`). */
  fetchImpl?: typeof fetch;
  /** Base reconnect delay, overridden by the server's `retry:` hint (default 3 000 ms). */
  retryMs?: number;
  /** Reconnect delay ceiling under sustained failure (default 30 000 ms). */
  maxRetryMs?: number;
  /** Continuous failure duration before state turns `degraded` (default 60 000 ms). */
  degradedAfterMs?: number;
  /** Seen-id dedupe set bound (default 2 000). */
  maxSeenIds?: number;
  /** Resume watermark persisted from a previous session, if any. */
  initialLastEventId?: string | null;
}

export interface EventStreamClient {
  start(): void;
  stop(): void;
  state(): EventStreamState;
  /** The current watermark (last durable SSE id seen). */
  lastEventId(): string | null;
}

export function createEventStreamClient(options: EventStreamClientOptions): EventStreamClient {
  const {
    buildRequest,
    onEvent,
    onStateChange,
    fetchImpl = globalThis.fetch.bind(globalThis),
    retryMs = 3_000,
    maxRetryMs = 30_000,
    degradedAfterMs = 60_000,
    maxSeenIds = 2_000,
    initialLastEventId = null,
  } = options;

  let state: EventStreamState = 'idle';
  let lastEventId: string | null = initialLastEventId;
  let serverRetryMs: number | null = null;
  let abort: AbortController | null = null;
  let running = false;
  let attempt = 0;
  let failingSince: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const seen = new Set<string>();
  const seenOrder: string[] = [];

  function setState(next: EventStreamState): void {
    if (state === next) return;
    state = next;
    onStateChange?.(next);
  }

  function markSeen(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > maxSeenIds) {
      const evicted = seenOrder.shift();
      if (evicted !== undefined) seen.delete(evicted);
    }
    return true;
  }

  function scheduleReconnect(): void {
    if (!running) return;
    attempt += 1;
    if (failingSince === null) failingSince = Date.now();
    setState(Date.now() - failingSince >= degradedAfterMs ? 'degraded' : 'reconnecting');
    // Full jitter over an exponentially growing cap, seeded by the server's
    // retry hint — a synchronized drop (deploy) must not reconnect in sync.
    const base = serverRetryMs ?? retryMs;
    const cap = Math.min(maxRetryMs, base * 2 ** Math.min(attempt - 1, 8));
    const delay = Math.random() * cap;
    retryTimer = setTimeout(() => void connect(), delay);
  }

  function handleFrame(frame: { id?: string; data: string; retry?: number }): void {
    if (frame.retry !== undefined) serverRetryMs = frame.retry;
    // Watermark rule: any id: line is a durable watermark (the server never
    // sets one on ephemeral frames).
    if (frame.id !== undefined && frame.id !== '') lastEventId = frame.id;
    if (frame.data === '') return; // retry-only frame

    let envelope: StreamedEvent;
    try {
      envelope = JSON.parse(frame.data) as StreamedEvent;
    } catch {
      return; // not an envelope — ignore
    }
    if (typeof envelope !== 'object' || envelope === null || typeof envelope.id !== 'string') return;
    if (!markSeen(envelope.id)) return; // duplicate (replay overlap / redelivery)
    onEvent(envelope);
  }

  async function connect(): Promise<void> {
    if (!running) return;
    if (state === 'idle' || state === 'stopped') setState('connecting');
    abort = new AbortController();
    const parser = createSseFrameParser();

    try {
      const request = await buildRequest();
      const response = await fetchImpl(request.url, {
        headers: {
          accept: 'text/event-stream',
          ...(lastEventId !== null ? { 'last-event-id': lastEventId } : {}),
          ...request.headers,
        },
        signal: abort.signal,
      });
      // A non-SSE content-type is a misroute (an SPA-fallback HTML page, a
      // proxy error body) — without this check it reads to end-of-body and
      // loops as if the server had cleanly closed, hammering the wrong URL.
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
        scheduleReconnect();
        return;
      }

      setState('connected');
      attempt = 0;
      failingSince = null;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          handleFrame(frame);
        }
      }
      // Server closed the stream — the routine capped-age cycle. Reconnect
      // promptly (jittered), without entering the failure path.
      if (running) {
        setState('reconnecting');
        const base = serverRetryMs ?? retryMs;
        retryTimer = setTimeout(() => void connect(), Math.random() * base);
      }
    } catch (error) {
      if (!running || (error instanceof DOMException && error.name === 'AbortError')) return;
      scheduleReconnect();
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    void connect();
  }

  function stop(): void {
    running = false;
    if (retryTimer) clearTimeout(retryTimer);
    abort?.abort();
    abort = null;
    setState('stopped');
  }

  return {
    start,
    stop,
    state: () => state,
    lastEventId: () => lastEventId,
  };
}
