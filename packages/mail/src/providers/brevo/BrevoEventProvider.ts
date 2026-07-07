import { z } from 'zod';
import type { Result } from '@octabits-io/foundation/result';
import { ok, err } from '@octabits-io/foundation/result';
import type { DeliveryStatus, NormalizedDeliveryEvent, MailEventParseError } from '../../base/delivery';

// ============================================================================
// Event → delivery-status mapping
// ============================================================================

/**
 * Map a raw Brevo transactional event to a provider-agnostic delivery status.
 * - `delivered` → `delivered`
 * - `hard_bounce` / `spam` / `blocked` / `invalid_email` → `bounced`
 * - `soft_bounce` / `deferred` / `error` → `failed` (transient/soft)
 * - everything else (opens, clicks, requests, unsubscribes…) → `null` (ignored)
 */
export function mapBrevoEventToDeliveryStatus(event: string): DeliveryStatus | null {
  switch (event) {
    case 'delivered':
      return 'delivered';
    case 'hard_bounce':
    case 'spam':
    case 'blocked':
    case 'invalid_email':
      return 'bounced';
    case 'soft_bounce':
    case 'deferred':
    case 'error':
      return 'failed';
    default:
      return null;
  }
}

// ============================================================================
// Lenient Zod schema for a Brevo event
// ============================================================================

// Brevo posts transactional events with a hyphenated `message-id` key (and
// occasionally a camelCase `messageId`). Keep the schema permissive.
const brevoEventSchema = z.looseObject({
  event: z.string().optional(),
  'message-id': z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

type BrevoEvent = z.infer<typeof brevoEventSchema>;

/**
 * Coerce the webhook payload to an array of raw event objects. Brevo posts a
 * single event per request, but tolerate batched `[...]` / `{ items: [...] }` /
 * `{ events: [...] }` shapes too.
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

function normalizeEvent(raw: BrevoEvent): NormalizedDeliveryEvent | null {
  const externalMessageId = raw['message-id'] ?? raw.messageId ?? null;
  const event = raw.event ?? null;
  // Without a Message-ID we can't match the event to a stored message; without an
  // event name we can't map a status. Skip either way.
  if (!externalMessageId || !event) return null;
  return {
    externalMessageId,
    event,
    deliveryStatus: mapBrevoEventToDeliveryStatus(event),
    reason: raw.reason ?? null,
  };
}

// ============================================================================
// Parser (pure — no network, no DB)
// ============================================================================

/**
 * Parse a Brevo transactional event webhook payload into normalized delivery
 * events. Total (never throws) → returns a Result. Events without a Message-ID
 * or event name are dropped; status-irrelevant events keep `deliveryStatus:
 * null` (the handler skips them).
 *
 * SECURITY: Brevo does NOT sign event webhooks — there is no signature to
 * verify, so this parser cannot authenticate the payload's origin. Endpoint
 * authentication is the consumer's responsibility: use an unguessable secret
 * path segment, an IP allowlist for Brevo's webhook egress ranges, and/or a
 * shared-secret header configured on the webhook, and treat every parsed
 * field as untrusted input regardless.
 */
export function parseBrevoEvents(
  payload: unknown,
): Result<NormalizedDeliveryEvent[], MailEventParseError> {
  const rawEvents = toEventArray(payload);
  if (rawEvents === null) {
    return err({ key: 'mail_event_parse_error', message: 'Brevo event payload is not an object or array' });
  }

  const events: NormalizedDeliveryEvent[] = [];
  for (const raw of rawEvents) {
    const parsed = brevoEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const normalized = normalizeEvent(parsed.data);
    if (normalized) events.push(normalized);
  }

  return ok(events);
}
