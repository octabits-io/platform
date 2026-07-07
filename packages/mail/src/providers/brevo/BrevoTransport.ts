import type { MailTransport, MailMessage } from '../../base/transport';
import type { MailDeliveryError, SentMailInfo } from '../../base/errors';
import type { Result } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';
import { type BrevoCredentials, createBrevoClient, formatBrevoError } from './brevo-client';
import type { BrevoClient } from './brevo-client';

// ============================================================================
// Configuration
// ============================================================================

export interface BrevoTransportCreateConfig {
  brevo: BrevoCredentials;
  logger: Logger;
}

// ============================================================================
// Transport Interface
// ============================================================================

export interface BrevoTransport extends MailTransport {
  readonly type: 'brevo';
  readonly brevoClient: BrevoClient;
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Creates a Brevo transport for email delivery via Brevo's Transactional Email
 * API. This transport only handles the actual sending of normalized messages.
 *
 * Unlike Mailjet, Brevo's `POST /smtp/email` returns the RFC 5322 Message-ID,
 * which we surface as `messageId`. That id can later be matched by a Brevo event
 * webhook to move the message to delivered/bounced — so Brevo is the only
 * outbound provider here that supports full delivery/bounce tracking.
 *
 * @example
 * ```typescript
 * const transport = createBrevoTransport({
 *   brevo: { apiKey: '...' },
 *   logger,
 * });
 *
 * await transport.send({
 *   from: { address: 'noreply@example.com', name: 'My App' },
 *   to: ['user@example.com'],
 *   subject: 'Hello',
 *   text: 'Plain text content',
 *   html: '<p>HTML content</p>',
 * });
 * ```
 */
export function createBrevoTransport(config: BrevoTransportCreateConfig): BrevoTransport {
  const client = createBrevoClient(config.brevo);
  const { logger } = config;

  async function send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>> {
    try {
      // NOTE: Brevo's transactional API exposes no per-message envelope sender
      // (Return-Path), so `message.returnPath` is ignored — bounces are tracked
      // via Brevo's event webhook (keyed on the returned Message-ID), not via a
      // tagged bounce address.
      const { messageId } = await client.sendTransacEmail({
        sender: {
          email: message.from.address,
          name: message.from.name,
        },
        to: message.to.map((email) => ({ email })),
        bcc: message.bcc?.map((email) => ({ email })),
        replyTo: message.replyTo
          ? { email: message.replyTo.address, name: message.replyTo.name }
          : undefined,
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
        attachment: message.attachments?.map((a) => ({
          name: a.filename,
          content: Buffer.from(a.content).toString('base64'),
        })),
      });

      return { ok: true, value: { messageId } };
    } catch (err) {
      logger.error('Error sending mail via Brevo', err instanceof Error ? err : new Error(String(err)));
      return {
        ok: false,
        error: {
          key: 'mail_delivery_error',
          message: `Failed to send mail via Brevo: ${formatBrevoError(err)}`,
          providerError: err,
        },
      };
    }
  }

  return {
    type: 'brevo' as const,
    send,
    brevoClient: client,
  };
}
