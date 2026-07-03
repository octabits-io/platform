import type { Result } from '@octabits-io/foundation/result';
import type { MailDeliveryError, SentMailInfo } from './errors';

// ============================================================================
// Mail Message - Provider-Agnostic Format
// ============================================================================

/**
 * Attachment for outgoing mail.
 * Content is provided as bytes; transports re-encode as needed.
 */
export interface MailAttachment {
  /** Filename shown to the recipient. */
  filename: string;
  /** Raw bytes (e.g. a PDF buffer). */
  content: Uint8Array;
  /** MIME type, e.g. `application/pdf`. Defaults to `application/octet-stream`. */
  contentType?: string;
}

/**
 * Normalized message ready for delivery.
 * This is the provider-agnostic format that all transports accept.
 */
export interface MailMessage {
  from: {
    address: string;
    name?: string;
  };
  to: string[];
  /** Address replies should go to. Useful when sending on behalf of another sender. */
  replyTo?: {
    address: string;
    name?: string;
  };
  /**
   * Envelope sender (SMTP MAIL FROM / Return-Path). Distinct from the visible
   * `from`; use it to route bounces/inbound replies via a tagged envelope
   * address while keeping the visible `from` unchanged. Honored only by
   * transports that expose an SMTP envelope (currently SMTP).
   */
  returnPath?: {
    address: string;
  };
  subject: string;
  text: string;
  html: string;
  /** Optional file attachments. Transports translate to provider-specific formats. */
  attachments?: MailAttachment[];
}

// ============================================================================
// Mail Transport Interface
// ============================================================================

/**
 * Simple transport interface - only handles delivery.
 * All business logic (config validation, template fetching, recipient
 * resolution) is expected to live in a higher-level mail service.
 */
export interface MailTransport {
  readonly type: string;
  /**
   * Deliver a normalized message. On success returns the provider's Message-ID
   * (or `null` when the provider does not expose it) so callers can persist it
   * for inbound header-threading / delivery correlation.
   */
  send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>>;
}
