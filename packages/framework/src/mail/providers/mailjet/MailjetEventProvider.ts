import { z } from 'zod';
import type { Result } from '../../../result/index.ts';
import { ok, err } from '../../../result/index.ts';
import type { DeliveryStatus, NormalizedDeliveryEvent, MailEventParseError } from '../../base/delivery';

// ============================================================================
// Event → delivery-status mapping
// ============================================================================

/**
 * Map a raw Mailjet Event API event to a provider-agnostic delivery status.
 *
 * - `sent` → `delivered`. Mailjet has no separate `delivered` event: its `sent`
 *   fires when the recipient's mail server *accepted* the message, which is the
 *   same fact Brevo reports as `delivered`. Mapping it to our `sent` instead
 *   would be a no-op — the outbound pipeline already wrote `sent` before the
 *   provider was ever called, so nothing would be learned from the webhook.
 * - `bounce` → `bounced` when Mailjet flags it hard, `failed` when soft. Unlike
 *   Brevo, Mailjet uses one event name for both and discriminates on the
 *   `hard_bounce` boolean.
 * - `blocked` / `spam` → `bounced` (terminal rejection).
 * - `open` / `click` / `unsub` → `null` (no delivery-state change).
 */
export function mapMailjetEventToDeliveryStatus(
  event: string,
  options: { hardBounce?: boolean } = {},
): DeliveryStatus | null {
  switch (event) {
    case 'sent':
      return 'delivered';
    case 'bounce':
      return options.hardBounce ? 'bounced' : 'failed';
    case 'blocked':
    case 'spam':
      return 'bounced';
    default:
      return null;
  }
}

// ============================================================================
// Lenient Zod schema for a Mailjet event
// ============================================================================

// Mailjet posts `Message_GUID` (the `MessageUUID` the Send API returned) plus a
// numeric `MessageID`. Keep the schema permissive — Mailjet adds fields over
// time and an unknown key must never drop an otherwise-usable event.
const mailjetEventSchema = z.looseObject({
  event: z.string().optional(),
  Message_GUID: z.string().nullable().optional(),
  MessageID: z.union([z.string(), z.number()]).nullable().optional(),
  hard_bounce: z.boolean().optional(),
  error: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
});

type MailjetEvent = z.infer<typeof mailjetEventSchema>;

/**
 * Coerce the webhook payload to an array of raw event objects. Mailjet posts a
 * single event per request by default and a JSON array when "group events" is
 * enabled; tolerate the wrapped shapes too, matching the Brevo parser.
 */
function toEventArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.events)) return obj.events;
    return [payload];
  }
  return null;
}

function normalizeEvent(raw: MailjetEvent): NormalizedDeliveryEvent | null {
  // `Message_GUID` is the handle the transport stored as `providerMessageId`, so
  // it is the only field that reliably matches a send. `MessageID` is a fallback
  // for the rare payload that omits the GUID, and a poor one twice over: a
  // consumer that stored the GUID will not match it, and Mailjet's ids run past
  // 2^53 (e.g. 19421777835146490), so `JSON.parse` has already rounded the value
  // before we see it. Still worth attempting — an unmatched event gets logged,
  // a skipped one vanishes silently.
  const externalMessageId = raw.Message_GUID
    ?? (raw.MessageID != null ? String(raw.MessageID) : null);
  const event = raw.event ?? null;
  if (!externalMessageId || !event) return null;
  return {
    externalMessageId,
    event,
    deliveryStatus: mapMailjetEventToDeliveryStatus(event, { hardBounce: raw.hard_bounce }),
    // `error` is the machine-ish cause ("user unknown"); `comment` is the
    // verbatim SMTP response, which is what an operator actually needs.
    reason: raw.comment ?? raw.error ?? null,
  };
}

// ============================================================================
// Parser (pure — no network, no DB)
// ============================================================================

/**
 * Parse a Mailjet Event API webhook payload into normalized delivery events.
 * Total (never throws) → returns a Result. Events without a correlation id or
 * event name are dropped; status-irrelevant events keep `deliveryStatus: null`
 * (the handler skips them).
 *
 * SECURITY: like Brevo, Mailjet does NOT sign event webhooks — this parser
 * cannot authenticate the payload's origin. Endpoint authentication is the
 * consumer's responsibility (unguessable secret path segment and/or an IP
 * allowlist); treat every parsed field as untrusted input regardless.
 */
export function parseMailjetEvents(
  payload: unknown,
): Result<NormalizedDeliveryEvent[], MailEventParseError> {
  const rawEvents = toEventArray(payload);
  if (rawEvents === null) {
    return err({ key: 'mail_event_parse_error', message: 'Mailjet event payload is not an object or array' });
  }

  const events: NormalizedDeliveryEvent[] = [];
  for (const raw of rawEvents) {
    const parsed = mailjetEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const normalized = normalizeEvent(parsed.data);
    if (normalized) events.push(normalized);
  }

  return ok(events);
}
