// ============================================================================
// @octabits-io/mail — provider-agnostic mail transport contract
// ============================================================================
//
// The root entry is dependency-free: the transport contract, the error
// taxonomy, and the two vendor-less transports (logger for dev, memory for
// tests). Vendor transports live behind subpath exports so consumers only
// install and load the SDKs they actually use:
//
//   @octabits-io/mail/smtp     — nodemailer   (optional peer: nodemailer)
//   @octabits-io/mail/mailjet  — node-mailjet (optional peer: node-mailjet)
//   @octabits-io/mail/brevo    — wretch       (optional peer: wretch)

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
