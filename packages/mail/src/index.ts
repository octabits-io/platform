// ============================================================================
// @octabits-io/mail — provider-agnostic mail transport contract + transports
// ============================================================================

// --- Base contract ---------------------------------------------------------
export type {
  MailTransport,
  MailMessage,
  MailAttachment,
} from './base/transport';
export type {
  MailConfigurationError,
  MailDeliveryError,
  MailTemplateError,
  MailNotConfiguredError,
  MailError,
  SentMailInfo,
  SendMailResult,
  RenderedEmail,
  RenderMailResult,
} from './base/errors';

// --- SMTP transport (nodemailer) -------------------------------------------
export {
  createSmtpTransport,
} from './providers/smtp/SmtpTransport';
export type {
  SmtpTransport,
  SmtpTransportCreateConfig,
} from './providers/smtp/SmtpTransport';
export {
  createSmtpTransporter,
  verifySmtpConnection,
} from './providers/smtp/smtp-client';
export type {
  SmtpTransportConfig,
} from './providers/smtp/smtp-client';

// --- Mailjet transport (node-mailjet) --------------------------------------
export {
  createMailjetTransport,
} from './providers/mailjet/MailjetTransport';
export type {
  MailjetTransport,
  MailjetTransportCreateConfig,
} from './providers/mailjet/MailjetTransport';
export {
  createMailjetClient,
  verifyMailjetConnection,
} from './providers/mailjet/mailjet-client';
export type {
  MailjetCredentials,
} from './providers/mailjet/mailjet-client';

// --- Brevo transport (wretch) ----------------------------------------------
export {
  createBrevoTransport,
} from './providers/brevo/BrevoTransport';
export type {
  BrevoTransport,
  BrevoTransportCreateConfig,
} from './providers/brevo/BrevoTransport';
export {
  createBrevoClient,
  verifyBrevoConnection,
  formatBrevoError,
} from './providers/brevo/brevo-client';
export type {
  BrevoClient,
  BrevoCredentials,
  BrevoSendEmailPayload,
  BrevoSendEmailResponse,
} from './providers/brevo/brevo-client';

// --- Logger transport (dev) ------------------------------------------------
export {
  createLoggerTransport,
} from './providers/logger/LoggerTransport';
export type {
  LoggerTransport,
  LoggerTransportDeps,
} from './providers/logger/LoggerTransport';

// --- Memory transport (test) -----------------------------------------------
export {
  createMemoryTransport,
} from './providers/memory/MemoryTransport';
export type {
  MemoryTransport,
} from './providers/memory/MemoryTransport';
