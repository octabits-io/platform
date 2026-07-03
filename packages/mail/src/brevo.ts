// @octabits-io/mail/brevo — Brevo outbound transport (wretch HTTP client).
// Requires the optional peer dependency `wretch`.
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
