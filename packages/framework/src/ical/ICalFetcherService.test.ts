import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../logger/index.ts';
import { createICalFetcherService } from './ICalFetcherService.ts';

const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
};

// Helper to create a mock Response object
function createMockResponse(options: {
  ok: boolean;
  statusText?: string;
  text?: string;
  headers?: Headers;
  body?: ReadableStream<Uint8Array> | null;
}): Response {
  return {
    ok: options.ok,
    statusText: options.statusText ?? '',
    status: options.ok ? 200 : 404,
    headers: options.headers ?? new Headers(),
    text: () => Promise.resolve(options.text ?? ''),
    json: () => Promise.resolve({}),
    blob: () => Promise.resolve(new Blob()),
    bytes: () => Promise.resolve(new Uint8Array()),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    formData: () => Promise.resolve(new FormData()),
    clone: () => createMockResponse(options),
    body: options.body ?? null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: '',
  } as unknown as Response;
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('ICalFetcherService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const service = createICalFetcherService({ logger: mockLogger });

  // Helper to get the mocked fetch
  const getMockFetch = () => vi.mocked(globalThis.fetch);

  describe('fetch', () => {
    it('should fetch and return calendar data with hash', async () => {
      const calendarData = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test@example.com
DTSTART:20250101
DTEND:20250102
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: calendarData,
      }));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.data).toContain('BEGIN:VCALENDAR');
        expect(result.value.hash).toBeDefined();
        expect(result.value.hasChanged).toBe(true);
      }
    });

    it('should convert webcal:// URLs to https://', async () => {
      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      }));

      const result = await service.fetch('webcal://example.com/calendar.ics');

      expect(result.ok).toBe(true);
      expect(getMockFetch()).toHaveBeenCalledWith(
        'https://example.com/calendar.ics',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should remove DTSTAMP lines case-insensitively', async () => {
      const calendarData = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTAMP:20250101T120000Z
dtstamp:20250101T120000Z
Dtstamp:20250101T120000Z
UID:test@example.com
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: calendarData,
      }));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.data).not.toContain('DTSTAMP');
        expect(result.value.data).not.toContain('dtstamp');
        expect(result.value.data).not.toContain('Dtstamp');
        expect(result.value.data).toContain('UID:test@example.com');
      }
    });

    it('should remove RFC 5545 folded DTSTAMP continuation lines', async () => {
      // A folded property continues on the next line with a leading space/tab.
      const calendarData = [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'DTSTAMP;X-LONG-PARAM=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2025010',
        ' 1T120000Z',
        '\t1T120000Z',
        'UID:test@example.com',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\n');

      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: calendarData,
      }));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.data).not.toContain('DTSTAMP');
        expect(result.value.data).not.toContain('1T120000Z');
        expect(result.value.data).toContain('UID:test@example.com');
      }
    });

    it('should produce equal hashes for payloads differing only in DTSTAMP', async () => {
      const base = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:test@example.com', 'END:VEVENT', 'END:VCALENDAR'];
      const payloadA = [base[0], 'DTSTAMP:20250101T000000Z', ...base.slice(1)].join('\n');
      const payloadB = [base[0], 'DTSTAMP:20260707T235959Z', ...base.slice(1)].join('\n');

      getMockFetch()
        .mockResolvedValueOnce(createMockResponse({ ok: true, text: payloadA }))
        .mockResolvedValueOnce(createMockResponse({ ok: true, text: payloadB }));

      const resultA = await service.fetch('https://example.com/calendar.ics');
      expect(resultA.ok).toBe(true);
      if (!resultA.ok) return;

      const resultB = await service.fetch('https://example.com/calendar.ics', resultA.value.hash);
      expect(resultB.ok).toBe(true);
      if (!resultB.ok) return;

      expect(resultB.value.hash).toBe(resultA.value.hash);
      expect(resultB.value.hasChanged).toBe(false);
    });

    it('should detect no change when hash matches previous', async () => {
      const calendarData = `BEGIN:VCALENDAR
VERSION:2.0
END:VCALENDAR`;

      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: calendarData,
      }));

      // First fetch to get the hash
      const result1 = await service.fetch('https://example.com/calendar.ics');
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;

      const hash = result1.value.hash;

      // Second fetch with same data and previous hash
      const result2 = await service.fetch('https://example.com/calendar.ics', hash);

      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.value.hasChanged).toBe(false);
        expect(result2.value.hash).toBe(hash);
      }
    });

    it('should detect change when hash differs from previous', async () => {
      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      }));

      const result = await service.fetch('https://example.com/calendar.ics', 'different-hash');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasChanged).toBe(true);
      }
    });

    it('should return error for non-OK response', async () => {
      getMockFetch().mockResolvedValue(createMockResponse({
        ok: false,
        statusText: 'Not Found',
      }));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_fetch_failed');
        expect(result.error.message).toContain('Not Found');
        expect(result.error.status).toBe(404);
      }
    });

    it('should return error when Content-Length exceeds limit', async () => {
      const maxSize = 5 * 1024 * 1024; // 5MB
      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: 'data',
        headers: new Headers({ 'content-length': String(maxSize + 1) }),
      }));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_too_large');
      }
    });

    it('should return error when response body exceeds limit', async () => {
      const maxSize = 5 * 1024 * 1024; // 5MB
      const largeData = 'x'.repeat(maxSize + 1);

      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: largeData,
      }));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_too_large');
      }
    });

    it('should abort a streaming body as soon as the byte cap is exceeded', async () => {
      // Small cap so the test streams only a few chunks.
      const capped = createICalFetcherService({ logger: mockLogger, maxResponseBytes: 10 });
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode('x'.repeat(8)));
        },
      });

      getMockFetch().mockResolvedValue(createMockResponse({ ok: true, body }));

      const result = await capped.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_too_large');
      }
      // 8 bytes ok, 16 bytes over cap → the (infinite) stream was read at most
      // a couple of times, never buffered in full.
      expect(pulls).toBeLessThanOrEqual(3);
    });

    it('should count the cap in bytes, not UTF-16 code units', async () => {
      // '€' is 1 UTF-16 code unit but 3 UTF-8 bytes: 4 chars = 12 bytes > 10.
      const capped = createICalFetcherService({ logger: mockLogger, maxResponseBytes: 10 });
      getMockFetch().mockResolvedValue(createMockResponse({ ok: true, body: streamOf('€€€€') }));

      const result = await capped.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_too_large');
      }
    });

    it('should decode a streamed body, including multi-byte chars split across chunks', async () => {
      // Split the 3-byte '€' across two chunks to exercise streaming decode.
      const euro = new TextEncoder().encode('SUMMARY:€');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(euro.slice(0, euro.length - 1));
          controller.enqueue(euro.slice(euro.length - 1));
          controller.close();
        },
      });
      getMockFetch().mockResolvedValue(createMockResponse({ ok: true, body }));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.data).toBe('SUMMARY:€');
      }
    });

    it('should reject non-http(s) schemes without fetching', async () => {
      for (const url of ['file:///etc/passwd', 'ftp://example.com/cal.ics', 'gopher://example.com/']) {
        const result = await service.fetch(url);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.key).toBe('ical_url_invalid');
        }
      }
      expect(getMockFetch()).not.toHaveBeenCalled();
    });

    it('should reject unparsable URLs without fetching', async () => {
      const result = await service.fetch('not a url at all');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_url_invalid');
      }
      expect(getMockFetch()).not.toHaveBeenCalled();
    });

    it('should reject literal private/loopback/link-local IP hostnames', async () => {
      const privateUrls = [
        'http://127.0.0.1/cal.ics',
        'http://127.8.9.10/cal.ics',
        'http://10.0.0.5/cal.ics',
        'http://172.16.0.1/cal.ics',
        'http://172.31.255.255/cal.ics',
        'http://192.168.1.1/cal.ics',
        'http://169.254.169.254/latest/meta-data',
        'http://0.0.0.0/cal.ics',
        'http://2130706433/cal.ics', // decimal 127.0.0.1 — normalized by URL
        'http://[::1]/cal.ics',
        'http://[fd00::1]/cal.ics',
        'http://[fe80::1]/cal.ics',
        'http://[::ffff:192.168.0.1]/cal.ics',
      ];

      for (const url of privateUrls) {
        const result = await service.fetch(url);
        expect(result.ok, url).toBe(false);
        if (!result.ok) {
          expect(result.error.key, url).toBe('ical_url_private_network');
        }
      }
      expect(getMockFetch()).not.toHaveBeenCalled();
    });

    it('should not misclassify public IPs as private', async () => {
      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      }));

      // 172.32/12 is outside 172.16/12; 11.x and 128.x are public.
      for (const url of ['http://172.32.0.1/cal.ics', 'http://11.0.0.1/cal.ics', 'http://128.0.0.1/cal.ics']) {
        const result = await service.fetch(url);
        expect(result.ok, url).toBe(true);
      }
    });

    it('should allow private addresses when allowPrivateNetwork is set', async () => {
      const permissive = createICalFetcherService({ logger: mockLogger, allowPrivateNetwork: true });
      getMockFetch().mockResolvedValue(createMockResponse({
        ok: true,
        text: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      }));

      const result = await permissive.fetch('http://127.0.0.1/cal.ics');

      expect(result.ok).toBe(true);
      expect(getMockFetch()).toHaveBeenCalledWith(
        'http://127.0.0.1/cal.ics',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should use an injected fetch instead of globalThis.fetch', async () => {
      const injected = vi.fn().mockResolvedValue(createMockResponse({
        ok: true,
        text: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
      }));
      const custom = createICalFetcherService({
        logger: mockLogger,
        fetch: injected as unknown as typeof fetch,
      });

      const result = await custom.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(true);
      expect(injected).toHaveBeenCalledTimes(1);
      expect(getMockFetch()).not.toHaveBeenCalled();
    });

    it('should redact userinfo from URLs in error messages and log metadata', async () => {
      const errorSpy = vi.fn();
      const spyLogger: Logger = { ...mockLogger, error: errorSpy };
      const spied = createICalFetcherService({ logger: spyLogger });

      // err-path via non-OK response
      getMockFetch().mockResolvedValueOnce(createMockResponse({ ok: false, statusText: 'Forbidden' }));
      const failed = await spied.fetch('https://user:hunter2@example.com/calendar.ics');
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.error.message).not.toContain('hunter2');
        expect(failed.error.message).not.toContain('user:');
        expect(failed.error.message).toContain('https://example.com/calendar.ics');
      }

      // logger-path via network error
      getMockFetch().mockRejectedValueOnce(new Error('Network error'));
      await spied.fetch('https://user:hunter2@example.com/calendar.ics');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const metadata = errorSpy.mock.calls[0]?.[2] as { url: string };
      expect(metadata.url).toBe('https://example.com/calendar.ics');
    });

    it('should return timeout error when fetch is aborted', async () => {
      // Mock fetch to throw AbortError
      getMockFetch().mockImplementation(async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      });

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_fetch_timeout');
        expect(result.error.message).toContain('30 seconds');
      }
    });

    it('should honor a configured timeoutMs in the timeout error', async () => {
      const quick = createICalFetcherService({ logger: mockLogger, timeoutMs: 5000 });
      getMockFetch().mockImplementation(async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      });

      const result = await quick.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.key).toBe('ical_fetch_timeout');
        expect(result.error.message).toContain('5 seconds');
      }
    });

    it('should pass AbortSignal to fetch', async () => {
      let capturedSignal: AbortSignal | null | undefined;

      getMockFetch().mockImplementation(async (_url, options) => {
        capturedSignal = options?.signal;
        return createMockResponse({
          ok: true,
          text: 'BEGIN:VCALENDAR\nEND:VCALENDAR',
        });
      });

      await service.fetch('https://example.com/calendar.ics');

      // Verify an AbortSignal was passed
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    });

    it('should handle network errors gracefully', async () => {
      getMockFetch().mockRejectedValue(new Error('Network error'));

      const result = await service.fetch('https://example.com/calendar.ics');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Network error');
      }
    });
  });
});
