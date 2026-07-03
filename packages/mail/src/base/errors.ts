import type { Result, OctError } from '@octabits-io/foundation/result';

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

export type MailError = MailConfigurationError | MailDeliveryError | MailTemplateError | MailNotConfiguredError;

/**
 * Successful-send metadata. `messageId` is the provider's RFC 5322 Message-ID
 * when available (SMTP always via nodemailer; Brevo via its transactional API;
 * Mailjet does not expose it → null), used by inbound matching pipelines for
 * header-threading. `null` when the provider does not surface it.
 */
export interface SentMailInfo {
  messageId: string | null;
}

export type SendMailResult = Result<SentMailInfo, MailError>;

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  recipients: string[];
  primaryRecipient: string;
}

export type RenderMailResult = Result<RenderedEmail, MailError>;
