/**
 * The Brevo client helpers, below the transport.
 *
 * `BrevoTransport.test.ts` drives `sendTransacEmail` through the transport;
 * these cover the two exports it never touches — the credential-check call and
 * the error formatter that decides what an operator reads in the audit log when
 * a send fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrevoClient, formatBrevoError, verifyBrevoConnection } from './brevo-client.ts';

const originalFetch = globalThis.fetch;

/** A real `Response`: wretch reads `ok`/`status`/headers/body through the real API. */
function stubFetch(body: unknown, status: number) {
  const mock = vi.fn(
    async (): Promise<Response> =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createBrevoClient', () => {
  it('posts the payload to /smtp/email with the api-key header', async () => {
    const fetchMock = stubFetch({ messageId: '<abc@brevo>' }, 201);

    const result = await createBrevoClient({ apiKey: 'key-123' }).sendTransacEmail({
      sender: { email: 'noreply@example.com' },
      to: [{ email: 'guest@example.com' }],
      subject: 'Hi',
      htmlContent: '<p>Hi</p>',
      textContent: 'Hi',
    });

    expect(result).toEqual({ messageId: '<abc@brevo>' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.brevo.com/v3/smtp/email');
    expect(new Headers(init.headers).get('api-key')).toBe('key-123');
  });

  it('normalises a missing messageId to null rather than undefined', async () => {
    stubFetch({}, 201);

    const result = await createBrevoClient({ apiKey: 'key-123' }).sendTransacEmail({
      sender: { email: 'noreply@example.com' },
      to: [{ email: 'guest@example.com' }],
      subject: 'Hi',
      htmlContent: '<p>Hi</p>',
      textContent: 'Hi',
    });

    expect(result).toEqual({ messageId: null });
  });
});

describe('verifyBrevoConnection', () => {
  it('calls the cheap /account endpoint and reports success', async () => {
    const fetchMock = stubFetch({ email: 'ops@example.com' }, 200);

    const result = await verifyBrevoConnection({ apiKey: 'key-123' });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(
      'https://api.brevo.com/v3/account',
    );
  });

  it('returns a mail_configuration_error carrying the formatted reason', async () => {
    // A rejected credential check must be a Result, not a throw: it runs at
    // boot/config time, where a crash tells the operator nothing.
    stubFetch({ code: 'unauthorized', message: 'Key not found' }, 401);

    const result = await verifyBrevoConnection({ apiKey: 'bad' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('mail_configuration_error');
    expect(result.error.message).toContain('Brevo API verification failed');
    expect(result.error.message).toContain('Key not found');
    expect(result.error.missingConfig).toEqual([]);
  });
});

describe('formatBrevoError', () => {
  it('describes a wretch HTTP error with status and the parsed body message', () => {
    const err = Object.assign(new Error('{"code":"invalid_parameter","message":"sender missing"}'), {
      status: 400,
      response: {} as Response,
      json: { code: 'invalid_parameter', message: 'sender missing' },
    });

    const formatted = formatBrevoError(err);

    expect(formatted).toContain('400');
    expect(formatted).toContain('sender missing');
  });

  it('falls back to the raw body when the error carries no parsed json', () => {
    const err = Object.assign(new Error('upstream exploded'), {
      status: 502,
      response: {} as Response,
      text: 'upstream exploded',
    });

    expect(formatBrevoError(err)).toContain('502');
    expect(formatBrevoError(err)).toContain('upstream exploded');
  });

  it('handles plain errors, strings and nullish values', () => {
    // Something readable must always reach the audit log — this is the last
    // formatting step before a failure is written down.
    expect(formatBrevoError(new Error('socket hang up'))).toContain('socket hang up');
    expect(formatBrevoError('plain string')).toBe('plain string');
    expect(formatBrevoError(null)).toBe('unknown error');
    expect(formatBrevoError(undefined)).toBe('unknown error');
    expect(typeof formatBrevoError({ weird: true })).toBe('string');
  });
});
