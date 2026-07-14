// @octabits-io/framework/mail/smtp — SMTP outbound transport (nodemailer).
// Requires the optional peer dependency `nodemailer`.
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
