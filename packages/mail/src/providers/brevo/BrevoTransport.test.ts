import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBrevoTransport } from './BrevoTransport';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn((): typeof logger => logger),
};

/**
 * wretch delegates to `globalThis.fetch`, so we stub it with a mock that returns
 * a real `Response`. Returning a genuine Response (not a hand-rolled object) is
 * important — wretch reads `ok`, `status`, headers, and the body via the real
 * Response API, including on its error path.
 */
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

describe('createBrevoTransport', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps a MailMessage to the Brevo payload and returns the provider Message-ID', async () => {
    const fetchMock = stubFetch({ messageId: '<abc@smtp-relay.mailin.fr>' }, 201);

    const transport = createBrevoTransport({ brevo: { apiKey: 'key-123' }, logger });
    const result = await transport.send({
      from: { address: 'noreply@tenant.com', name: 'Tenant' },
      to: ['guest@example.com'],
      replyTo: { address: 'reply@tenant.com', name: 'Reply' },
      subject: 'Hello',
      text: 'plain',
      html: '<p>html</p>',
      attachments: [{ filename: 'doc.pdf', content: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe('<abc@smtp-relay.mailin.fr>');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // wretch calls fetch(url, options). Assert URL, method, auth header, body.
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const opts = call[1];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(opts.method).toBe('POST');
    expect(new Headers(opts.headers).get('api-key')).toBe('key-123');

    const sent = JSON.parse(opts.body as string);
    expect(sent.sender).toEqual({ email: 'noreply@tenant.com', name: 'Tenant' });
    expect(sent.to).toEqual([{ email: 'guest@example.com' }]);
    expect(sent.replyTo).toEqual({ email: 'reply@tenant.com', name: 'Reply' });
    expect(sent.subject).toBe('Hello');
    expect(sent.textContent).toBe('plain');
    expect(sent.htmlContent).toBe('<p>html</p>');
    expect(sent.attachment).toEqual([
      { name: 'doc.pdf', content: Buffer.from([1, 2, 3]).toString('base64') },
    ]);
  });

  it('returns messageId null when Brevo omits it', async () => {
    stubFetch({}, 201);
    const transport = createBrevoTransport({ brevo: { apiKey: 'key-123' }, logger });
    const result = await transport.send({
      from: { address: 'noreply@tenant.com' },
      to: ['guest@example.com'],
      subject: 'Hi',
      text: 't',
      html: '<p>t</p>',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBeNull();
  });

  it('returns a mail_delivery_error on a non-2xx response', async () => {
    stubFetch({ code: 'unauthorized', message: 'Key not found' }, 401);

    const transport = createBrevoTransport({ brevo: { apiKey: 'bad' }, logger });
    const result = await transport.send({
      from: { address: 'noreply@tenant.com' },
      to: ['guest@example.com'],
      subject: 'Hi',
      text: 't',
      html: '<p>t</p>',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('mail_delivery_error');
      expect(result.error.message).toContain('401');
      expect(result.error.message).toContain('unauthorized');
    }
    expect(logger.error).toHaveBeenCalled();
  });
});
