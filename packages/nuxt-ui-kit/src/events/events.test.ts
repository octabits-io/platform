/**
 * Unit tests for the kit events surface: the SSE frame parser (spec
 * conformance over chunk boundaries) and the stream client's contract —
 * watermark from id: lines only, seen-id dedupe, Last-Event-ID on reconnect,
 * and the routine server-close reconnect cycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSseFrameParser } from './sseParser.ts';
import { createEventStreamClient, type StreamedEvent } from './client.ts';

describe('createSseFrameParser', () => {
  it('parses a complete frame with id, event, and data', () => {
    const parser = createSseFrameParser();
    const frames = parser.push('id: 41\nevent: order.created\ndata: {"n":1}\n\n');
    expect(frames).toEqual([{ id: '41', event: 'order.created', data: '{"n":1}' }]);
  });

  it('handles frames split across arbitrary chunk boundaries', () => {
    const parser = createSseFrameParser();
    const full = 'id: 7\ndata: {"a":1}\n\ndata: {"b":2}\n\n';
    const frames = [];
    for (const char of full) frames.push(...parser.push(char));
    expect(frames).toEqual([
      { id: '7', data: '{"a":1}' },
      { data: '{"b":2}' },
    ]);
  });

  it('joins multi-line data and skips comments', () => {
    const parser = createSseFrameParser();
    const frames = parser.push(': hb\ndata: line1\ndata: line2\n\n');
    expect(frames).toEqual([{ data: 'line1\nline2' }]);
  });

  it('parses retry-only frames and normalizes CRLF', () => {
    const parser = createSseFrameParser();
    const frames = parser.push('retry: 3000\r\n\r\n');
    expect(frames).toEqual([{ retry: 3000, data: '' }]);
  });

  it('emits nothing for pure heartbeats', () => {
    const parser = createSseFrameParser();
    expect(parser.push(': hb\n\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stream client against a scripted fetch
// ---------------------------------------------------------------------------

function envelope(id: string, seq?: number): StreamedEvent {
  return {
    id,
    ...(seq !== undefined ? { seq } : {}),
    type: 'order.created',
    scopeKey: 'scope-a',
    at: '2026-07-29T00:00:00.000Z',
    lane: seq !== undefined ? 'durable' : 'ephemeral',
    data: {},
  };
}

function sseBody(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function streamResponse(...frames: string[]): Response {
  return new Response(sseBody(...frames), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('createEventStreamClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it('delivers events, advances the watermark on id: frames only, and dedupes', async () => {
    const durableFrame = `id: 5\ndata: ${JSON.stringify(envelope('evt-5', 5))}\n\n`;
    const ephemeralFrame = `data: ${JSON.stringify(envelope('inline-1'))}\n\n`;
    const duplicateFrame = `data: ${JSON.stringify(envelope('inline-1'))}\n\n`;
    const fetchImpl = vi.fn(async () => streamResponse(durableFrame, ephemeralFrame, duplicateFrame));
    const events: StreamedEvent[] = [];

    const client = createEventStreamClient({
      buildRequest: () => ({ url: 'http://test/events' }),
      onEvent: (event) => events.push(event),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    client.start();
    await drainMicrotasks();

    expect(events.map((event) => event.id)).toEqual(['evt-5', 'inline-1']);
    expect(client.lastEventId()).toBe('5'); // the ephemeral frame did not advance it
    client.stop();
  });

  it('sends Last-Event-ID on reconnect after a server close', async () => {
    const first = `id: 9\ndata: ${JSON.stringify(envelope('evt-9', 9))}\n\n`;
    const fetchImpl = vi.fn(async () => streamResponse(first));
    const client = createEventStreamClient({
      buildRequest: () => ({ url: 'http://test/events', headers: { authorization: 'Bearer t' } }),
      onEvent: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 1_000,
    });
    client.start();
    await drainMicrotasks();
    expect(client.state()).toBe('reconnecting'); // server closed → routine cycle

    await vi.advanceTimersByTimeAsync(1_100);
    await drainMicrotasks();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((secondCall[1].headers as Record<string, string>)['last-event-id']).toBe('9');
    expect((secondCall[1].headers as Record<string, string>)['authorization']).toBe('Bearer t');
    client.stop();
  });

  it('backs off with growing delays on failures and reports degraded after the threshold', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const states: string[] = [];
    const client = createEventStreamClient({
      buildRequest: () => ({ url: 'http://test/events' }),
      onEvent: () => {},
      onStateChange: (state) => states.push(state),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 100,
      degradedAfterMs: 500,
    });
    client.start();
    await drainMicrotasks();
    expect(states).toContain('reconnecting');

    // Walk through several failed cycles past the degraded threshold.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(400);
      await drainMicrotasks();
    }
    expect(states).toContain('degraded');
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(2);
    client.stop();
    expect(client.state()).toBe('stopped');
  });

  it('treats a non-SSE response (SPA fallback HTML) as a failure, not a clean close', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    const states: string[] = [];
    const client = createEventStreamClient({
      buildRequest: () => ({ url: 'http://test/events' }),
      onEvent: () => {},
      onStateChange: (state) => states.push(state),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 100,
    });
    client.start();
    await drainMicrotasks();
    // Failure path (backoff), never 'connected' for an HTML body.
    expect(states).not.toContain('connected');
    expect(states).toContain('reconnecting');
    client.stop();
  });

  it('honours the server retry hint', async () => {
    const fetchImpl = vi.fn(async () => streamResponse('retry: 50\n\n'));
    const client = createEventStreamClient({
      buildRequest: () => ({ url: 'http://test/events' }),
      onEvent: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryMs: 60_000, // would stall the test if the hint were ignored
    });
    client.start();
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(60);
    await drainMicrotasks();
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    client.stop();
  });
});
