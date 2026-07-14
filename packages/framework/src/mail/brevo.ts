// @octabits-io/framework/mail/brevo — Brevo outbound transport (wretch HTTP client).
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
  DEFAULT_BREVO_TIMEOUT_MS,
} from './providers/brevo/brevo-client';
export type {
  BrevoClient,
  BrevoCredentials,
  BrevoSendEmailPayload,
  BrevoSendEmailResponse,
} from './providers/brevo/brevo-client';

// --- Inbound-parsing webhook normalizer ------------------------------------
// The normalized `NormalizedInboundMessage`/`NormalizedInboundAttachment` types
// and `MailInboundParseError` live in the provider-agnostic root contract
// (`@octabits-io/framework/mail`); this parser targets them.
export {
  parseBrevoInbound,
} from './providers/brevo/BrevoInboundProvider';

// --- Transactional event / delivery-status normalizer ----------------------
// The normalized `NormalizedDeliveryEvent`/`DeliveryStatus` types and
// `MailEventParseError` live in the root contract.
export {
  parseBrevoEvents,
  mapBrevoEventToDeliveryStatus,
} from './providers/brevo/BrevoEventProvider';
