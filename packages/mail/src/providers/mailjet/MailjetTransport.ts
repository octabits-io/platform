import type { MailTransport, MailMessage } from '../../base/transport';
import type { MailDeliveryError, SentMailInfo } from '../../base/errors';
import type { Result } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';
import { type MailjetCredentials, createMailjetClient } from './mailjet-client';

// ============================================================================
// Configuration
// ============================================================================

export interface MailjetTransportCreateConfig {
  mailjet: MailjetCredentials;
  logger: Logger;
}

// ============================================================================
// Transport Interface
// ============================================================================

export interface MailjetTransport extends MailTransport {
  readonly type: 'mailjet';
  readonly mailjetClient: ReturnType<typeof createMailjetClient>;
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Creates a Mailjet transport for email delivery.
 * This transport only handles the actual sending of normalized messages.
 *
 * @example
 * ```typescript
 * const transport = createMailjetTransport({
 *   mailjet: { apiKey: '...', apiSecret: '...' },
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
export function createMailjetTransport(config: MailjetTransportCreateConfig): MailjetTransport {
  const client = createMailjetClient(config.mailjet);
  const { logger } = config;

  async function send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>> {
    try {
      // NOTE: Mailjet's Send v3.1 API exposes neither the RFC 5322 Message-ID
      // header nor a per-message envelope sender (Return-Path). So we cannot
      // stamp `messageId` for header-threading (→ null; inbound matching falls
      // back to the tagged reply address) and `message.returnPath` is ignored
      // here — tagged bounce routing is SMTP-only.
      await client.post('send', { version: 'v3.1' }).request({
        Messages: [{
          From: {
            Email: message.from.address,
            Name: message.from.name,
          },
          To: message.to.map(email => ({ Email: email })),
          Bcc: message.bcc?.map(email => ({ Email: email })),
          ReplyTo: message.replyTo
            ? { Email: message.replyTo.address, Name: message.replyTo.name }
            : undefined,
          Subject: message.subject,
          TextPart: message.text,
          HTMLPart: message.html,
          Attachments: message.attachments?.map((a) => ({
            ContentType: a.contentType ?? 'application/octet-stream',
            Filename: a.filename,
            Base64Content: Buffer.from(a.content).toString('base64'),
          })),
        }],
      });

      return { ok: true, value: { messageId: null } };
    } catch (err) {
      logger.error('Error sending mail via Mailjet', err instanceof Error ? err : new Error(String(err)));
      return {
        ok: false,
        error: {
          key: 'mail_delivery_error',
          message: `Failed to send mail via Mailjet: ${formatMailjetError(err)}`,
          providerError: err,
        },
      };
    }
  }

  return {
    type: 'mailjet' as const,
    send,
    mailjetClient: client,
  };
}

/**
 * Extracts a one-line, human-readable description from whatever node-mailjet threw.
 * Handles the common shapes: HttpRequestError (with `statusCode` / `ErrorMessage` /
 * `ErrorIdentifier` / response body), plain Error, and unknown values. Falls back
 * to JSON serialization so something useful always reaches the audit log.
 */
function formatMailjetError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;

  const e = err as Record<string, unknown> & { message?: string };
  const status = typeof e.statusCode === 'number' ? `${e.statusCode}` : undefined;
  const identifier = typeof e.ErrorIdentifier === 'string' ? e.ErrorIdentifier : undefined;
  const apiMessage = typeof e.ErrorMessage === 'string'
    ? e.ErrorMessage
    : typeof e.originalMessage === 'string'
      ? e.originalMessage
      : typeof e.message === 'string'
        ? e.message
        : undefined;

  // Per-message errors from /send v3.1 live inside response.body.Messages[].Errors
  let perMessageErrors: string | undefined;
  const responseBody = (e.response as { body?: unknown })?.body;
  if (responseBody && typeof responseBody === 'object') {
    const messages = (responseBody as { Messages?: unknown }).Messages;
    if (Array.isArray(messages)) {
      const errs = messages.flatMap((m) => {
        const errors = (m as { Errors?: unknown }).Errors;
        return Array.isArray(errors) ? errors : [];
      });
      if (errs.length > 0) {
        perMessageErrors = errs
          .map((x) => {
            const o = x as { ErrorIdentifier?: string; ErrorMessage?: string; ErrorCode?: string };
            return [o.ErrorCode, o.ErrorIdentifier, o.ErrorMessage].filter(Boolean).join(' / ');
          })
          .join('; ');
      }
    }
  }

  const parts = [status, identifier, apiMessage, perMessageErrors].filter(Boolean);
  if (parts.length > 0) return parts.join(' — ');

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
