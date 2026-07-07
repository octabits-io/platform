import type { MailTransport, MailMessage } from '../../base/transport';
import type { MailDeliveryError, SentMailInfo } from '../../base/errors';
import type { Result } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';

// ============================================================================
// Transport Interface
// ============================================================================

export interface LoggerTransport extends MailTransport {
  readonly type: 'logger';
}

// ============================================================================
// Transport Dependencies
// ============================================================================

export interface LoggerTransportDeps {
  logger: Logger;
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Creates a logger transport for development/testing.
 * Logs message details using the provided logger instead of sending actual emails.
 *
 * @example
 * ```typescript
 * const transport = createLoggerTransport({ logger });
 *
 * await transport.send({
 *   from: { address: 'noreply@example.com', name: 'My App' },
 *   to: ['user@example.com'],
 *   subject: 'Hello',
 *   text: 'Plain text content',
 *   html: '<p>HTML content</p>',
 * });
 * // Logs: Mail sent (logger transport) with to, subject, and body attributes
 * ```
 */
export function createLoggerTransport({ logger }: LoggerTransportDeps): LoggerTransport {
  async function send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>> {
    // Synthesize a deterministic-shaped dev Message-ID so capture and inbound
    // header-threading paths are exercisable offline.
    const messageId = `<dev-${Date.now()}-${Math.round(Math.random() * 1e9).toString(36)}@local>`;
    logger.info('Mail sent (logger transport)', {
      from: message.from.name
        ? `${message.from.name} <${message.from.address}>`
        : message.from.address,
      to: message.to.join(', '),
      bcc: message.bcc?.join(', '),
      replyTo: message.replyTo
        ? message.replyTo.name
          ? `${message.replyTo.name} <${message.replyTo.address}>`
          : message.replyTo.address
        : undefined,
      returnPath: message.returnPath?.address,
      subject: message.subject,
      body: message.text || message.html,
      messageId,
    });
    return { ok: true, value: { messageId } };
  }

  return {
    type: 'logger' as const,
    send,
  };
}
