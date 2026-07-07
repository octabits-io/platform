import type { Result } from '@octabits-io/foundation/result';
import type { MailDeliveryError, SentMailInfo } from '../../base/errors';
import type { MailTransport, MailMessage } from '../../base/transport';

// ============================================================================
// Transport Interface
// ============================================================================

export interface MemoryTransport extends MailTransport {
  readonly type: 'memory';
  /** Get all captured messages */
  getMessages(): MailMessage[];
  /** Get messages by recipient email (matches both `to` and `bcc`) */
  getMessagesTo(email: string): MailMessage[];
  /** Get the last sent message */
  getLastMessage(): MailMessage | undefined;
  /** Clear all captured messages */
  clear(): void;
  /** Get count of captured messages */
  count(): number;
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Creates a memory transport for testing.
 * Stores all sent messages in memory for later inspection/assertion.
 *
 * @example
 * ```typescript
 * const transport = createMemoryTransport();
 *
 * await transport.send({ from: { address: 'a@b.c' }, to: ['x@y.z'], subject: 'Hi', text: '', html: '' });
 *
 * expect(transport.count()).toBe(1);
 * expect(transport.getLastMessage()?.subject).toContain('Hi');
 * ```
 */
export function createMemoryTransport(): MemoryTransport {
  const messages: MailMessage[] = [];

  async function send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>> {
    messages.push(message);
    const messageId = `<memory-${messages.length}@test>`;
    return { ok: true, value: { messageId } };
  }

  return {
    type: 'memory' as const,
    send,
    getMessages: () => [...messages],
    getMessagesTo: (email) => messages.filter(m => m.to.includes(email) || (m.bcc?.includes(email) ?? false)),
    getLastMessage: () => messages[messages.length - 1],
    clear: () => { messages.length = 0; },
    count: () => messages.length,
  };
}
