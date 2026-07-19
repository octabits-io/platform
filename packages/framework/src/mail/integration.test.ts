/**
 * Integration tests for the SMTP transport against a real SMTP server
 * (Mailpit via testcontainers; Docker required).
 *
 * The unit tests mock nodemailer; these prove a normalized `MailMessage`
 * actually crosses the wire — envelope recipients (BCC), reply-to, and
 * attachments included — and that `verifySmtpConnection` reflects the real
 * TLS posture. Mailpit is plaintext-only, so this is also the coverage that
 * exercises the `requireTLS: false` opt-out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { Logger } from '../logger/index.ts';
import { createSmtpTransport } from './smtp.ts';
import { verifySmtpConnection } from './smtp.ts';
import type { SmtpTransportConfig } from './smtp.ts';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

let container: StartedTestContainer;
let apiBase: string;
let smtp: SmtpTransportConfig;

beforeAll(async () => {
  container = await new GenericContainer('axllent/mailpit:latest')
    // Require SMTP auth but accept any credentials over the plaintext dev
    // connection — mirrors a real relay that wants a login without forcing us
    // to provision TLS certs for a throwaway container.
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: 'true', MP_SMTP_AUTH_ALLOW_INSECURE: 'true' })
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/api/v1/info', 8025).forStatusCode(200))
    .start();

  apiBase = `http://${container.getHost()}:${container.getMappedPort(8025)}/api/v1`;
  smtp = {
    host: container.getHost(),
    port: container.getMappedPort(1025),
    requireTLS: false, // Mailpit offers no STARTTLS; opt out of the default requirement.
    auth: { user: 'mailpit', pass: 'anything' },
  };
});

afterAll(async () => {
  await container?.stop();
});

interface MailpitMessageSummary {
  ID: string;
  Subject: string;
}
interface MailpitAddress {
  Address: string;
  Name: string;
}
interface MailpitMessage {
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Bcc: MailpitAddress[];
  ReplyTo: MailpitAddress[];
  Attachments: Array<{ FileName: string; ContentType: string }>;
}

async function latestMessage(): Promise<MailpitMessage> {
  const list = (await (await fetch(`${apiBase}/messages?limit=1`)).json()) as {
    messages: MailpitMessageSummary[];
  };
  const summary = list.messages[0];
  if (!summary) throw new Error('Mailpit received no messages');
  return (await (await fetch(`${apiBase}/message/${summary.ID}`)).json()) as MailpitMessage;
}

describe('SMTP transport against Mailpit', () => {
  it('verifies a plaintext connection when requireTLS is disabled', async () => {
    const result = await verifySmtpConnection(smtp, 10_000);
    expect(result.ok).toBe(true);
  });

  it('fails verification when STARTTLS is required against a plaintext server', async () => {
    // The default posture (requireTLS derived from !secure) cannot connect to a
    // server that offers no TLS — this is exactly why the opt-out exists.
    const strict: SmtpTransportConfig = { ...smtp, requireTLS: undefined };
    const result = await verifySmtpConnection(strict, 10_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('mail_configuration_error');
  });

  it('delivers a normalized message with reply-to, BCC, and an attachment', async () => {
    await fetch(`${apiBase}/messages`, { method: 'DELETE' });

    const transport = createSmtpTransport({ smtp, logger: silentLogger });
    const send = await transport.send({
      from: { address: 'noreply@demo.example', name: 'Contact Desk' },
      to: ['ada@example.com'],
      bcc: ['audit@demo.example'],
      replyTo: { address: 'help@demo.example', name: 'Help' },
      subject: 'Welcome aboard',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      attachments: [
        { filename: 'welcome.txt', content: new TextEncoder().encode('attached bytes'), contentType: 'text/plain' },
      ],
    });

    expect(send.ok).toBe(true);
    if (send.ok) expect(send.value.messageId).toBeTruthy();

    const msg = await latestMessage();
    expect(msg.Subject).toBe('Welcome aboard');
    expect(msg.From.Address).toBe('noreply@demo.example');
    expect(msg.To.map((a) => a.Address)).toContain('ada@example.com');
    expect(msg.ReplyTo.map((a) => a.Address)).toContain('help@demo.example');
    // BCC is delivered via RCPT TO but never appears in the visible headers;
    // Mailpit records the envelope recipient separately.
    expect(msg.Bcc.map((a) => a.Address)).toContain('audit@demo.example');
    expect(msg.Attachments.map((a) => a.FileName)).toContain('welcome.txt');
  });
});
