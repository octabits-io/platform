import type { OctError } from '../../result/index.ts';

// ============================================================================
// Delivery status — provider-agnostic contract
// ============================================================================

/**
 * The closed set of provider-agnostic delivery statuses, as a runtime tuple.
 * Exported so a consumer can derive its own storage enum from this single
 * source of truth (e.g. Drizzle `pgEnum('...', MAIL_DELIVERY_STATUSES)`),
 * rather than hand-maintaining a parallel list that must be re-verified against
 * every provider mapping. The order is stable — treat it as the canonical
 * declaration order for enum definitions.
 */
export const MAIL_DELIVERY_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'bounced', 'discarded'] as const;

/**
 * Provider-agnostic delivery status for an outbound message. Providers map
 * their native transactional events onto this closed set:
 * - `queued` / `sent` — set by the outbound pipeline (pre-provider-event).
 * - `delivered` — the provider confirmed delivery.
 * - `bounced` — a hard rejection (hard bounce, spam, blocked, invalid address).
 * - `failed` — a transient/soft failure (soft bounce, deferred, provider error).
 * - `discarded` — never handed to a provider at all: a review gate held the mail
 *   and a human decided not to send it. No provider ever emits this; it exists so
 *   a held-then-rejected mail is distinguishable from one that failed in transit,
 *   which matters when the audit trail is what an operator reads.
 */
export type DeliveryStatus = (typeof MAIL_DELIVERY_STATUSES)[number];

/**
 * A normalized transactional delivery event. The webhook + queue handler
 * consume only this shape, so a second provider can slot in by emitting it.
 */
export interface NormalizedDeliveryEvent {
  /**
   * The provider's correlation handle for the message this event concerns —
   * whatever the outbound side stored as `SentMailInfo.providerMessageId`. For
   * SMTP and Brevo that is the RFC 5322 Message-ID, so it also matches
   * `NormalizedInboundMessage.externalMessageId`; for Mailjet it is the
   * `Message_GUID`, which is not a header id and never matches inbound.
   */
  externalMessageId: string;
  /** Raw provider event name (e.g. `delivered`, `bounce`). */
  event: string;
  /**
   * Mapped delivery status, or `null` for events that don't change delivery
   * state (opens/clicks/etc.) — the handler skips those.
   */
  deliveryStatus: DeliveryStatus | null;
  /** Provider failure reason, when present. */
  reason: string | null;
}

// ============================================================================
// Error
// ============================================================================

/** Raised when a delivery-event webhook payload cannot be parsed. */
export interface MailEventParseError extends OctError {
  key: 'mail_event_parse_error';
  message: string;
}
