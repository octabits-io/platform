/**
 * The SSE endpoint over an {@link EventHub} — a **plain fetch handler**
 * (`(request) => Response`), not a framework route, on purpose:
 *
 * - It spends no route-type budget. Consumers whose route chain is at
 *   TypeScript's recursion limit register it with `.mount()`; the stream needs
 *   no client types at all (clients consume it with a fetch-based SSE reader,
 *   not an API client). The constraint was found on Elysia, where one more
 *   `.use()` tipped a real consumer's chain into TS2589 — worth keeping.
 * - It runs on any web-standard runtime (Bun, Node ≥18, workers) and any
 *   framework that can hand over a `Request`.
 *
 * A thin Hono sub-app wrapper ships at `@octabits-io/framework/hono/events`
 * for `app.route()`-style registration.
 *
 * Wire discipline baked in:
 *
 * - `x-accel-buffering: no` on the response — nginx-style proxies buffer
 *   streaming responses to death without it. Do not remove.
 * - Heartbeat comment frames (default 20 s) keep idle-timeout proxies happy.
 * - **Only durable events carry an SSE `id:`** — the client persists the last
 *   seen id as its replay watermark, and an ephemeral event id there would
 *   point at nothing in the outbox.
 * - Connections are closed server-side after `maxConnectionAgeMs` (default
 *   5 min) so the consumer's auth gets re-evaluated on reconnect; the client
 *   treats that close as a routine cycle, not an error.
 *
 * Replay: on connect with a `Last-Event-ID` header (or `lastEventId` query
 * param — some readers can't set headers) and a configured store, missed
 * durable events are replayed from `watermark − replayLookback`. The lookback
 * over-delivers on purpose (outbox `seq` is insert-ordered, not
 * commit-ordered); the client's seen-id dedupe absorbs it.
 */
import type { Logger } from '../logger/index.ts';
import type { EventEnvelope, EventOutboxStore } from './types.ts';
import type { EventHub } from './hub.ts';

/** What the consumer's auth resolution yields for one stream request. */
export interface ResolvedEventSubscriber {
  scopeKey: string;
  subscriberId: string;
  /**
   * Evaluate an envelope's opaque `audience.permission` against this
   * subscriber's grants. Omit it and permission-carrying events are withheld
   * (fail closed).
   */
  can?: (permission: unknown) => boolean;
}

/**
 * The injected auth seam: map an incoming request to a subscriber, or `null`
 * to reject (401). The framework never inspects credentials itself — bind
 * your JWT validation, API keys, or opaque tokens here.
 */
export type ResolveEventSubscriber = (
  request: Request,
) => Promise<ResolvedEventSubscriber | null> | ResolvedEventSubscriber | null;

export interface CreateEventStreamHandlerDeps {
  hub: EventHub;
  resolveSubscriber: ResolveEventSubscriber;
  /** Enables Last-Event-ID replay. Omit for a purely live (ephemeral-only) stream. */
  store?: Pick<EventOutboxStore, 'readSince'>;
  logger?: Logger;
  /** Comment-frame interval (default 20 000 ms). Keep well under proxy idle timeouts. */
  heartbeatMs?: number;
  /** Server-side connection age cap (default 300 000 ms). 0 disables. */
  maxConnectionAgeMs?: number;
  /** Concurrent streams per (scopeKey, subscriberId) before 429 (default 5). */
  maxConnectionsPerSubscriber?: number;
  /** SSE `retry:` hint sent on connect (default 3 000 ms). */
  retryHintMs?: number;
  /** How far below the client watermark replay starts (default 100 seq units). */
  replayLookback?: number;
  /** Max rows replayed per connect (default 500). */
  replayLimit?: number;
}

export interface EventStreamHandler {
  /** The fetch handler — `.mount()` it, or serve it directly. */
  handler: (request: Request) => Promise<Response>;
  /** Live connection counts (observability). */
  metrics: { connections(): number };
}

const encoder = new TextEncoder();

function sseFrame(envelope: EventEnvelope): string {
  // Watermark rule: only durable events (which have a seq) get an id: line.
  const idLine = envelope.lane === 'durable' && envelope.seq !== undefined ? `id: ${envelope.seq}\n` : '';
  return `${idLine}event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export function createEventStreamHandler(deps: CreateEventStreamHandlerDeps): EventStreamHandler {
  const {
    hub,
    resolveSubscriber,
    store,
    logger,
    heartbeatMs = 20_000,
    maxConnectionAgeMs = 300_000,
    maxConnectionsPerSubscriber = 5,
    retryHintMs = 3_000,
    replayLookback = 100,
    replayLimit = 500,
  } = deps;

  /** (scopeKey → subscriberId → open connections) for the per-subscriber cap. */
  const connections = new Map<string, Map<string, number>>();
  let totalConnections = 0;

  function trackOpen(scopeKey: string, subscriberId: string): void {
    const perScope = connections.get(scopeKey) ?? new Map<string, number>();
    if (!connections.has(scopeKey)) connections.set(scopeKey, perScope);
    perScope.set(subscriberId, (perScope.get(subscriberId) ?? 0) + 1);
    totalConnections += 1;
  }

  function trackClose(scopeKey: string, subscriberId: string): void {
    const perScope = connections.get(scopeKey);
    if (!perScope) return;
    const count = (perScope.get(subscriberId) ?? 1) - 1;
    if (count <= 0) perScope.delete(subscriberId);
    else perScope.set(subscriberId, count);
    if (perScope.size === 0) connections.delete(scopeKey);
    totalConnections = Math.max(0, totalConnections - 1);
  }

  function parseLastEventId(request: Request): number | null {
    const url = new URL(request.url);
    const raw = request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId');
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  async function handler(request: Request): Promise<Response> {
    const jsonResponse = (status: number, body: { key: string; message: string }) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    const subscriber = await resolveSubscriber(request);
    if (!subscriber) {
      return jsonResponse(401, { key: 'unauthorized', message: 'Not authorized for this stream' });
    }
    const { scopeKey, subscriberId } = subscriber;

    const open = connections.get(scopeKey)?.get(subscriberId) ?? 0;
    if (open >= maxConnectionsPerSubscriber) {
      return jsonResponse(429, {
        key: 'too_many_connections',
        message: `Connection limit (${maxConnectionsPerSubscriber}) reached`,
      });
    }

    const lastEventId = parseLastEventId(request);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let unsubscribe: (() => void) | undefined;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const close = () => {
          if (closed) return;
          closed = true;
          for (const timer of timers) clearTimeout(timer);
          unsubscribe?.();
          trackClose(scopeKey, subscriberId);
          try {
            controller.close();
          } catch {
            // Stream already errored — accounting above is what matters.
          }
        };
        const send = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            close();
          }
        };

        trackOpen(scopeKey, subscriberId);
        request.signal.addEventListener('abort', close);
        send(`retry: ${retryHintMs}\n\n`);

        const authorize = (envelope: EventEnvelope): boolean => {
          const permission = envelope.audience?.permission;
          if (permission === undefined) return true;
          return subscriber.can ? subscriber.can(permission) : false;
        };

        const subscribeLive = () => {
          if (closed) return;
          unsubscribe = hub.subscribe({
            scopeKey,
            subscriberId,
            authorize,
            onEvent: (envelope) => send(sseFrame(envelope)),
          });
        };

        if (store && lastEventId !== null) {
          const afterSeq = Math.max(0, lastEventId - replayLookback);
          // Live first, replay second: an event committed during the replay
          // read would be lost the other way round (it is not yet in the read
          // result, and the live subscription doesn't exist). The overlap this
          // ordering produces is absorbed by the client's seen-id dedupe.
          subscribeLive();
          void Promise.resolve(store.readSince(scopeKey, afterSeq, replayLimit))
            .then((envelopes) => {
              for (const envelope of envelopes) {
                if (authorize(envelope)) send(sseFrame(envelope));
              }
            })
            .catch((error) => {
              logger?.error('Event stream replay failed', error instanceof Error ? error : undefined, {
                scopeKey,
                subscriberId,
              });
            });
        } else {
          subscribeLive();
        }

        if (heartbeatMs > 0) {
          const heartbeat = setInterval(() => send(`: hb\n\n`), heartbeatMs);
          timers.push(heartbeat as unknown as ReturnType<typeof setTimeout>);
        }
        if (maxConnectionAgeMs > 0) timers.push(setTimeout(close, maxConnectionAgeMs));
      },
      cancel: () => {
        // Client went away without an abort event reaching us.
        if (!closed) {
          closed = true;
          for (const timer of timers) clearTimeout(timer);
          unsubscribe?.();
          trackClose(scopeKey, subscriberId);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        // Load-bearing: without it, buffering reverse proxies (nginx) hold
        // the stream until it ends — i.e. forever.
        'x-accel-buffering': 'no',
      },
    });
  }

  return { handler, metrics: { connections: () => totalConnections } };
}
