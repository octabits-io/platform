// @octabits-io/framework/mail/mailjet — Mailjet outbound transport (node-mailjet).
// Requires the optional peer dependency `node-mailjet`.
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
  DEFAULT_MAILJET_TIMEOUT_MS,
} from './providers/mailjet/mailjet-client';
export type {
  MailjetCredentials,
} from './providers/mailjet/mailjet-client';
