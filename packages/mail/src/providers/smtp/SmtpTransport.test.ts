import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock nodemailer so no real SMTP connection is made. `sendMail` is shared so
// tests can assert on the exact options nodemailer received. `vi.hoisted` keeps
// the mock fns available to the hoisted `vi.mock` factory.
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close: vi.fn(), verify: vi.fn() }));
  return { sendMail, createTransport };
});

vi.mock('nodemailer', () => ({
  default: { createTransport },
}));

import { createSmtpTransport } from './SmtpTransport';
import { createSmtpTransporter, verifySmtpConnection } from './smtp-client';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn((): typeof logger => logger),
};

const smtp = { host: 'smtp.example.com', port: 587, auth: { user: 'u', pass: 'p' } };

describe('createSmtpTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps a MailMessage to nodemailer options and returns the Message-ID', async () => {
    sendMail.mockResolvedValueOnce({ messageId: '<smtp-1@example.com>' });

    const transport = createSmtpTransport({ smtp, logger });
    expect(transport.type).toBe('smtp');

    const result = await transport.send({
      from: { address: 'noreply@tenant.com', name: 'Tenant' },
      to: ['guest@example.com'],
      bcc: ['notify@tenant.com'],
      replyTo: { address: 'reply@tenant.com', name: 'Reply' },
      returnPath: { address: 'bounce+abc@platform.com' },
      subject: 'Hello',
      text: 'plain',
      html: '<p>html</p>',
      attachments: [{ filename: 'doc.pdf', content: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe('<smtp-1@example.com>');

    expect(sendMail).toHaveBeenCalledTimes(1);
    const opts = sendMail.mock.calls[0]![0] as Record<string, any>;
    expect(opts.from).toEqual({ name: 'Tenant', address: 'noreply@tenant.com' });
    expect(opts.to).toEqual(['guest@example.com']);
    expect(opts.bcc).toEqual(['notify@tenant.com']);
    expect(opts.replyTo).toEqual({ name: 'Reply', address: 'reply@tenant.com' });
    // returnPath sets the SMTP envelope sender without changing the visible From.
    // The envelope recipient list must include BCC addresses (RCPT TO delivery).
    expect(opts.envelope).toEqual({ from: 'bounce+abc@platform.com', to: ['guest@example.com', 'notify@tenant.com'] });
    expect(opts.subject).toBe('Hello');
    expect(opts.text).toBe('plain');
    expect(opts.html).toBe('<p>html</p>');
    expect(opts.attachments).toEqual([
      { filename: 'doc.pdf', content: Buffer.from([1, 2, 3]), contentType: 'application/pdf' },
    ]);
  });

  it('omits envelope when no returnPath and uses bare from address when no name', async () => {
    sendMail.mockResolvedValueOnce({ messageId: undefined });

    const transport = createSmtpTransport({ smtp, logger });
    const result = await transport.send({
      from: { address: 'noreply@tenant.com' },
      to: ['guest@example.com'],
      subject: 'Hi',
      text: 't',
      html: '<p>t</p>',
    });

    expect(result.ok).toBe(true);
    // messageId absent → null
    if (result.ok) expect(result.value.messageId).toBeNull();

    const opts = sendMail.mock.calls[0]![0] as Record<string, any>;
    expect(opts.from).toBe('noreply@tenant.com');
    expect(opts.bcc).toBeUndefined();
    expect(opts.replyTo).toBeUndefined();
    expect(opts.envelope).toBeUndefined();
  });

  it('returns a mail_delivery_error and logs when sendMail throws', async () => {
    sendMail.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN', response: '535 auth failed' }),
    );

    const transport = createSmtpTransport({ smtp, logger });
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
      expect(result.error.message).toContain('EAUTH');
      expect(result.error.message).toContain('535');
      expect(result.error.message).toContain('AUTH PLAIN');
      expect(result.error.message).toContain('535 auth failed');
    }
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('shared SMTP transport options (send + verify use the same builder)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds identical TLS options for send and verify (verify adds timeouts only)', async () => {
    createSmtpTransporter(smtp);
    await verifySmtpConnection(smtp, 5_000);

    expect(createTransport).toHaveBeenCalledTimes(2);
    const sendOpts = (createTransport.mock.calls[0] as unknown as [Record<string, any>])[0];
    const verifyOpts = (createTransport.mock.calls[1] as unknown as [Record<string, any>])[0];

    // STARTTLS required when not using implicit TLS — in BOTH configs.
    expect(sendOpts.secure).toBe(false);
    expect(sendOpts.requireTLS).toBe(true);
    const { connectionTimeout, greetingTimeout, ...verifyRest } = verifyOpts;
    expect(verifyRest).toEqual(sendOpts);
    expect(connectionTimeout).toBe(5_000);
    expect(greetingTimeout).toBe(5_000);
  });

  it('disables requireTLS for implicit-TLS (secure) configs in both paths', async () => {
    const secureCfg = { ...smtp, secure: true };
    createSmtpTransporter(secureCfg);
    await verifySmtpConnection(secureCfg);

    const sendOpts = (createTransport.mock.calls[0] as unknown as [Record<string, any>])[0];
    const verifyOpts = (createTransport.mock.calls[1] as unknown as [Record<string, any>])[0];
    expect(sendOpts.secure).toBe(true);
    expect(sendOpts.requireTLS).toBe(false);
    expect(verifyOpts.secure).toBe(true);
    expect(verifyOpts.requireTLS).toBe(false);
  });
});
