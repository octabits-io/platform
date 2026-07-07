import { describe, it, expect } from 'vitest';
import { createMemoryTransport } from './MemoryTransport';
import type { MailMessage } from '../../base/transport';

function msg(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    from: { address: 'noreply@tenant.com', name: 'Tenant' },
    to: ['guest@example.com'],
    subject: 'Hello',
    text: 'plain',
    html: '<p>html</p>',
    ...overrides,
  };
}

describe('createMemoryTransport', () => {
  it('captures sent messages and returns a synthetic Message-ID', async () => {
    const transport = createMemoryTransport();
    expect(transport.type).toBe('memory');
    expect(transport.count()).toBe(0);

    const r1 = await transport.send(msg());
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.messageId).toBe('<memory-1@test>');

    const r2 = await transport.send(msg({ subject: 'Second' }));
    if (r2.ok) expect(r2.value.messageId).toBe('<memory-2@test>');

    expect(transport.count()).toBe(2);
    expect(transport.getLastMessage()?.subject).toBe('Second');
  });

  it('filters messages by recipient', async () => {
    const transport = createMemoryTransport();
    await transport.send(msg({ to: ['a@x.com'] }));
    await transport.send(msg({ to: ['b@x.com'] }));

    expect(transport.getMessagesTo('a@x.com')).toHaveLength(1);
    expect(transport.getMessagesTo('b@x.com')[0]?.to).toEqual(['b@x.com']);
    expect(transport.getMessagesTo('none@x.com')).toHaveLength(0);
  });

  it('records bcc and matches it in getMessagesTo', async () => {
    const transport = createMemoryTransport();
    await transport.send(msg({ to: ['a@x.com'], bcc: ['hidden@x.com'] }));

    expect(transport.getLastMessage()?.bcc).toEqual(['hidden@x.com']);
    expect(transport.getMessagesTo('hidden@x.com')).toHaveLength(1);
    expect(transport.getMessagesTo('a@x.com')).toHaveLength(1);
  });

  it('getMessages returns a copy that does not mutate internal state', async () => {
    const transport = createMemoryTransport();
    await transport.send(msg());
    const snapshot = transport.getMessages();
    snapshot.push(msg({ subject: 'injected' }));
    expect(transport.count()).toBe(1);
  });

  it('clear() empties the buffer', async () => {
    const transport = createMemoryTransport();
    await transport.send(msg());
    transport.clear();
    expect(transport.count()).toBe(0);
    expect(transport.getLastMessage()).toBeUndefined();
  });
});
