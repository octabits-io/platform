import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@octabits-io/foundation/logger';
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
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: '',
  } as unknown as Response;
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

      await service.fetch('webcal://example.com/calendar.ics');

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
