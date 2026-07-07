import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-mailjet so no real API call is made. The client shape is
// `client.post('send', { version }).request({ Messages: [...] })`. `vi.hoisted`
// keeps the mock fns available to the hoisted `vi.mock` factory.
const { request, post, apiConnect } = vi.hoisted(() => {
  const request = vi.fn();
  const post = vi.fn(() => ({ request }));
  const apiConnect = vi.fn(() => ({ post }));
  return { request, post, apiConnect };
});

vi.mock('node-mailjet', () => ({
  default: { apiConnect },
}));

import { createMailjetTransport } from './MailjetTransport';
import { createMailjetClient, DEFAULT_MAILJET_TIMEOUT_MS } from './mailjet-client';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn((): typeof logger => logger),
};

const mailjet = { apiKey: 'key', apiSecret: 'secret' };

describe('createMailjetTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a MailMessage to the Mailjet v3.1 payload and returns messageId null', async () => {
    request.mockResolvedValueOnce({ body: { Messages: [{ Status: 'success' }] } });

    const transport = createMailjetTransport({ mailjet, logger });
    expect(transport.type).toBe('mailjet');

    const result = await transport.send({
      from: { address: 'noreply@tenant.com', name: 'Tenant' },
      to: ['guest@example.com', 'other@example.com'],
      bcc: ['notify@tenant.com'],
      replyTo: { address: 'reply@tenant.com', name: 'Reply' },
      subject: 'Hello',
      text: 'plain',
      html: '<p>html</p>',
      attachments: [{ filename: 'doc.pdf', content: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' }],
    });

    expect(result.ok).toBe(true);
    // Mailjet Send v3.1 does not expose the Message-ID → always null.
    if (result.ok) expect(result.value.messageId).toBeNull();

    expect(post).toHaveBeenCalledWith('send', { version: 'v3.1' });
    const payload = request.mock.calls[0]![0] as { Messages: any[] };
    const m = payload.Messages[0];
    expect(m.From).toEqual({ Email: 'noreply@tenant.com', Name: 'Tenant' });
    expect(m.To).toEqual([{ Email: 'guest@example.com' }, { Email: 'other@example.com' }]);
    expect(m.Bcc).toEqual([{ Email: 'notify@tenant.com' }]);
    expect(m.ReplyTo).toEqual({ Email: 'reply@tenant.com', Name: 'Reply' });
    expect(m.Subject).toBe('Hello');
    expect(m.TextPart).toBe('plain');
    expect(m.HTMLPart).toBe('<p>html</p>');
    expect(m.Attachments).toEqual([
      { ContentType: 'application/pdf', Filename: 'doc.pdf', Base64Content: Buffer.from([1, 2, 3]).toString('base64') },
    ]);
  });

  it('defaults attachment content-type and omits ReplyTo when not provided', async () => {
    request.mockResolvedValueOnce({ body: {} });

    const transport = createMailjetTransport({ mailjet, logger });
    await transport.send({
      from: { address: 'noreply@tenant.com' },
      to: ['guest@example.com'],
      subject: 'Hi',
      text: 't',
      html: '<p>t</p>',
      attachments: [{ filename: 'raw.bin', content: new Uint8Array([9]) }],
    });

    const m = (request.mock.calls[0]![0] as { Messages: any[] }).Messages[0];
    expect(m.ReplyTo).toBeUndefined();
    expect(m.Bcc).toBeUndefined();
    expect(m.Attachments[0].ContentType).toBe('application/octet-stream');
  });

  it('returns a mail_delivery_error and logs when request rejects', async () => {
    request.mockRejectedValueOnce(
      Object.assign(new Error('req failed'), {
        statusCode: 401,
        ErrorIdentifier: 'abc',
        ErrorMessage: 'API key authentication failure',
      }),
    );

    const transport = createMailjetTransport({ mailjet, logger });
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
      expect(result.error.message).toContain('API key authentication failure');
    }
    expect(logger.error).toHaveBeenCalled();
  });

  it('connects the client with a default request timeout (overridable via timeoutMs)', () => {
    createMailjetClient(mailjet);
    expect(apiConnect).toHaveBeenLastCalledWith('key', 'secret', {
      options: { timeout: DEFAULT_MAILJET_TIMEOUT_MS },
    });

    createMailjetClient({ ...mailjet, timeoutMs: 5_000 });
    expect(apiConnect).toHaveBeenLastCalledWith('key', 'secret', {
      options: { timeout: 5_000 },
    });
  });
});
