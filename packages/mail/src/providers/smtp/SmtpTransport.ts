import type { Transporter } from 'nodemailer';
import type { MailTransport, MailMessage } from '../../base/transport';
import type { MailDeliveryError, SentMailInfo } from '../../base/errors';
import type { Result } from '@octabits-io/foundation/result';
import type { Logger } from '@octabits-io/foundation/logger';
import { type SmtpTransportConfig, createSmtpTransporter } from './smtp-client';

// ============================================================================
// Configuration
// ============================================================================

export interface SmtpTransportCreateConfig {
  smtp: SmtpTransportConfig;
  logger: Logger;
}

// ============================================================================
// Transport Interface
// ============================================================================

export interface SmtpTransport extends MailTransport {
  readonly type: 'smtp';
  readonly transporter: Transporter;
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Creates an SMTP transport for email delivery.
 * This transport only handles the actual sending of normalized messages.
 *
 * @example
 * ```typescript
 * const transport = createSmtpTransport({
 *   smtp: { host: 'smtp.example.com', port: 587, auth: { ... } },
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
export function createSmtpTransport(config: SmtpTransportCreateConfig): SmtpTransport {
  const transporter = createSmtpTransporter(config.smtp);
  const { logger } = config;

  async function send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>> {
    try {
      const info = await transporter.sendMail({
        from: message.from.name
          ? { name: message.from.name, address: message.from.address }
          : message.from.address,
        to: message.to,
        replyTo: message.replyTo
          ? message.replyTo.name
            ? { name: message.replyTo.name, address: message.replyTo.address }
            : message.replyTo.address
          : undefined,
        // Set the SMTP envelope sender (MAIL FROM / Return-Path) without changing
        // the visible From. Only when a tagged bounce address is supplied.
        envelope: message.returnPath
          ? { from: message.returnPath.address, to: message.to }
          : undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
      });

      return { ok: true, value: { messageId: info.messageId ?? null } };
    } catch (err) {
      logger.error('Error sending mail via SMTP', err instanceof Error ? err : new Error(String(err)));
      return {
        ok: false,
        error: {
          key: 'mail_delivery_error',
          message: `Failed to send mail via SMTP: ${formatSmtpError(err)}`,
          providerError: err,
        },
      };
    }
  }

  return {
    type: 'smtp' as const,
    send,
    transporter,
  };
}

/**
 * Extracts a one-line, human-readable description from whatever nodemailer threw.
 * Pulls the fields nodemailer actually populates on SMTP failures: `code`
 * (e.g. EAUTH, ECONNECTION, ETIMEDOUT, EENVELOPE), `responseCode` (numeric SMTP
 * reply like 535/550), `command` (the SMTP verb that failed, e.g. "AUTH PLAIN",
 * "RCPT TO"), and the server's `response` text. Falls back to JSON serialization
 * so something useful always reaches the audit log.
 */
function formatSmtpError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;

  const e = err as Record<string, unknown> & { message?: string };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const responseCode = typeof e.responseCode === 'number' ? `${e.responseCode}` : undefined;
  const command = typeof e.command === 'string' ? e.command : undefined;
  const response = typeof e.response === 'string' ? e.response : undefined;
  const message = typeof e.message === 'string' ? e.message : undefined;

  // Prefer the server's response (it explains *why*); fall back to message.
  const detail = response ?? message;

  const parts = [
    code,
    responseCode,
    command ? `at ${command}` : undefined,
    detail,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(' — ');

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
