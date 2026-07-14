import type { Logger } from '../../logger/index.ts';
import type { MailMessage, MailTransport } from '../base/transport';

/**
 * Wraps an inner transport so every message's `to` list is replaced with
 * `[overrideRecipient]` before delivery. Intended exclusively for local
 * development — point it at an address the developer controls so outgoing mail
 * can never reach a real recipient.
 *
 * The inner transport still receives the full message (subject, body,
 * attachments) so the email stays inspectable; only the recipient list is
 * mutated. This is a pure `MailTransport` wrapper — no vendor dependency.
 */
export function createDevOverrideMailTransport(
  inner: MailTransport,
  overrideRecipient: string,
  logger: Logger,
): MailTransport {
  return {
    type: inner.type,
    async send(message: MailMessage) {
      logger.warn('[mail dev-override] redirecting outgoing mail', {
        originalTo: message.to.join(', '),
        originalBcc: message.bcc?.join(', '),
        overrideTo: overrideRecipient,
        subject: message.subject,
      });
      // BCC is dropped, not redirected — otherwise a real address could still
      // receive dev mail through the blind copy.
      return inner.send({ ...message, to: [overrideRecipient], bcc: undefined });
    },
  };
}
