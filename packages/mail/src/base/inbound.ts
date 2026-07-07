import type { OctError } from '@octabits-io/foundation/result';

// ============================================================================
// Normalized inbound types — provider-agnostic contract
// ============================================================================
//
// The provider-agnostic shapes an inbound-parsing provider emits. They live in
// the root contract so any inbound provider (Brevo today, others later) can
// target the same type — the downstream matching/storage pipeline consumes only
// these shapes. Concrete parsers (e.g. `parseBrevoInbound`) live behind the
// vendor subpaths.

/**
 * A single normalized inbound message.
 *
 * `externalMessageId` is the RFC 5322 Message-ID — the dedup key across
 * redeliveries and the anchor for header-threading.
 */
export interface NormalizedInboundMessage {
  /** RFC 5322 Message-ID. Dedup key across redeliveries. */
  externalMessageId: string;
  /** Provider-native message uuid, when present — used for reconciliation/replay APIs. */
  providerUuid: string | null;
  inReplyTo: string | null;
  /** Raw References header chain, space-separated. */
  references: string | null;
  from: { address: string; name: string | null };
  /** Recipient addresses only (a tagged reply address rides in here). */
  to: string[];
  cc: string[];
  replyTo: string | null;
  subject: string | null;
  /** Reply-stripped body — the provider's extracted message when present, else the raw text. */
  strippedText: string | null;
  /** Full raw text body (fallback + audit). */
  rawText: string | null;
  rawHtml: string | null;
  /** Provider-declared send timestamp (ISO string as provided). */
  sentAt: string | null;
  spamScore: number | null;
  attachments: NormalizedInboundAttachment[];
}

export interface NormalizedInboundAttachment {
  name: string;
  contentType: string;
  contentLength: number;
  contentId: string | null;
  /** Provider download token — the bytes are fetched separately. */
  downloadToken: string;
}

// ============================================================================
// Error
// ============================================================================

/** Raised when an inbound webhook payload cannot be parsed into the normalized shape. */
export interface MailInboundParseError extends OctError {
  key: 'mail_inbound_parse_error';
  message: string;
}
