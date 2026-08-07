import type { Result, OctError } from '../../result/index.ts';

export interface MailConfigurationError extends OctError {
  key: 'mail_configuration_error';
  message: string;
  missingConfig?: string[];
}

export interface MailDeliveryError extends OctError {
  key: 'mail_delivery_error';
  message: string;
  providerError?: unknown;
}

export interface MailTemplateError extends OctError {
  key: 'mail_template_error';
  message: string;
  templateId?: number;
}

export interface MailNotConfiguredError extends OctError {
  key: 'mail_not_configured';
  message: string;
}

/**
 * A recipient (or reply/bounce) address was missing or failed the dispatch
 * layer's sanitization check (separators, whitespace, control characters, or
 * not shaped like an email address). Refused before any transport is invoked.
 */
export interface MailInvalidRecipientError extends OctError {
  key: 'invalid_recipient';
  message: string;
  /** The offending address, when safe to echo. */
  address?: string;
}

export type MailError =
  | MailConfigurationError
  | MailDeliveryError
  | MailTemplateError
  | MailNotConfiguredError
  | MailInvalidRecipientError;

/**
 * Successful-send metadata. The two ids answer different questions and a
 * provider may expose one without the other — keep them apart.
 */
export interface SentMailInfo {
  /**
   * The provider's RFC 5322 Message-ID (SMTP always, via nodemailer; Brevo via
   * its transactional API; Mailjet never → `null`). This is the id a recipient's
   * reply echoes in `In-Reply-To`/`References`, so it — and only it — can thread
   * an inbound reply back to the message that prompted it.
   */
  messageId: string | null;
  /**
   * An opaque, provider-scoped handle for the accepted message, used to
   * correlate the provider's later delivery events (delivered / bounce / spam)
   * back to it. NOT an RFC 5322 Message-ID: never use it for header threading.
   *
   * Providers that expose the RFC id use it for both jobs and set both fields to
   * the same value. Mailjet is the case that forced them apart — its Send v3.1
   * response carries a `MessageUUID` that the Event API echoes as
   * `Message_GUID`, but no header. Collapsing the two would mean either
   * discarding Mailjet's only correlation handle (leaving every Mailjet send
   * unobservable after hand-off — a bounce indistinguishable from a delivery)
   * or feeding a non-header id to inbound threading, where it can never match.
   *
   * Optional so existing `MailTransport` implementations keep compiling;
   * consumers should read `providerMessageId ?? messageId`.
   */
  providerMessageId?: string | null;
}

export type SendMailResult = Result<SentMailInfo, MailError>;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  recipients: string[];
  /** BCC recipients (e.g. the notifications copy in `customer_and_notifications` mode). */
  bcc?: string[];
  primaryRecipient: string;
}

export type RenderMailResult = Result<RenderedEmail, MailError>;
