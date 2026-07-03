import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLoggerTransport } from './LoggerTransport';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn((): typeof logger => logger),
};

describe('createLoggerTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs the message and returns a synthetic dev Message-ID', async () => {
    const transport = createLoggerTransport({ logger });
    expect(transport.type).toBe('logger');

    const result = await transport.send({
      from: { address: 'noreply@tenant.com', name: 'Tenant' },
      to: ['guest@example.com', 'other@example.com'],
      replyTo: { address: 'reply@tenant.com', name: 'Reply' },
      returnPath: { address: 'bounce+abc@platform.com' },
      subject: 'Hello',
      text: 'plain body',
      html: '<p>html</p>',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toMatch(/^<dev-\d+-[a-z0-9]+@local>$/);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, attrs] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Mail sent (logger transport)');
    expect(attrs.from).toBe('Tenant <noreply@tenant.com>');
    expect(attrs.to).toBe('guest@example.com, other@example.com');
    expect(attrs.replyTo).toBe('Reply <reply@tenant.com>');
    expect(attrs.returnPath).toBe('bounce+abc@platform.com');
    expect(attrs.subject).toBe('Hello');
    expect(attrs.body).toBe('plain body');
  });

  it('falls back to html when text is empty and bare address when no name', async () => {
    const transport = createLoggerTransport({ logger });
    await transport.send({
      from: { address: 'noreply@tenant.com' },
      to: ['guest@example.com'],
      subject: 'Hi',
      text: '',
      html: '<p>only html</p>',
    });

    const [, attrs] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(attrs.from).toBe('noreply@tenant.com');
    expect(attrs.replyTo).toBeUndefined();
    expect(attrs.body).toBe('<p>only html</p>');
  });
});
