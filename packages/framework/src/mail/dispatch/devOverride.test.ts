/**
 * The dev-override transport wrapper: the last line of defence between a
 * developer's machine and a real customer inbox. Every assertion here is about
 * mail NOT reaching someone.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDevOverrideMailTransport } from './devOverride.ts';
import type { MailMessage, MailTransport } from '../base/transport';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn((): typeof logger => logger),
};

function innerTransport(): MailTransport & { send: ReturnType<typeof vi.fn> } {
  return {
    type: 'smtp',
    send: vi.fn().mockResolvedValue({ ok: true, value: { messageId: 'm1' } }),
  } as unknown as MailTransport & { send: ReturnType<typeof vi.fn> };
}

const message: MailMessage = {
  from: { address: 'noreply@example.com', name: 'Desk' },
  to: ['customer@example.com', 'second@example.com'],
  bcc: ['ops@example.com'],
  subject: 'Booking confirmed',
  html: '<p>Confirmed</p>',
  text: 'Confirmed',
};

describe('createDevOverrideMailTransport', () => {
  it('replaces every recipient with the override address', async () => {
    const inner = innerTransport();
    const transport = createDevOverrideMailTransport(inner, 'dev@example.com', logger);

    await transport.send(message);

    expect(inner.send).toHaveBeenCalledOnce();
    expect(inner.send.mock.calls[0]![0].to).toEqual(['dev@example.com']);
  });

  it('DROPS the bcc rather than redirecting it', async () => {
    // Redirecting the blind copy would still be a leak the developer cannot
    // see — a real address receiving dev mail through a header nobody reads.
    const inner = innerTransport();

    await createDevOverrideMailTransport(inner, 'dev@example.com', logger).send(message);

    expect(inner.send.mock.calls[0]![0].bcc).toBeUndefined();
  });

  it('leaves the rest of the message intact so it stays inspectable', async () => {
    const inner = innerTransport();

    await createDevOverrideMailTransport(inner, 'dev@example.com', logger).send(message);

    const sent = inner.send.mock.calls[0]![0] as MailMessage;
    expect(sent.subject).toBe(message.subject);
    expect(sent.html).toBe(message.html);
    expect(sent.text).toBe(message.text);
    expect(sent.from).toEqual(message.from);
  });

  it('keeps the inner transport type and result', async () => {
    const inner = innerTransport();
    const transport = createDevOverrideMailTransport(inner, 'dev@example.com', logger);

    expect(transport.type).toBe('smtp');
    await expect(transport.send(message)).resolves.toEqual({ ok: true, value: { messageId: 'm1' } });
  });

  it('warns with the original recipients, so the redirect is never silent', async () => {
    const inner = innerTransport();

    await createDevOverrideMailTransport(inner, 'dev@example.com', logger).send(message);

    expect(logger.warn).toHaveBeenCalledWith(
      '[mail dev-override] redirecting outgoing mail',
      expect.objectContaining({
        originalTo: 'customer@example.com, second@example.com',
        originalBcc: 'ops@example.com',
        overrideTo: 'dev@example.com',
      }),
    );
  });
});
