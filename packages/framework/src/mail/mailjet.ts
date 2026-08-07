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

// --- Transactional event / delivery-status normalizer ----------------------
// The normalized `NormalizedDeliveryEvent`/`DeliveryStatus` types and
// `MailEventParseError` live in the root contract
// (`@octabits-io/framework/mail`); this parser targets them. Events correlate on
// `Message_GUID` — the `MessageUUID` the transport surfaced as
// `SentMailInfo.providerMessageId`, not an RFC 5322 Message-ID.
export {
  parseMailjetEvents,
  mapMailjetEventToDeliveryStatus,
} from './providers/mailjet/MailjetEventProvider';
