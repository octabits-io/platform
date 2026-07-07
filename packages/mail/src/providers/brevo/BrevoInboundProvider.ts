import { z } from 'zod';
import type { Result } from '@octabits-io/foundation/result';
import { ok, err } from '@octabits-io/foundation/result';
import type {
  NormalizedInboundMessage,
  NormalizedInboundAttachment,
  MailInboundParseError,
} from '../../base/inbound';

// ============================================================================
// Lenient Zod schema for Brevo's inbound payload
// ============================================================================

// Brevo posts address fields either as `{ Address, Name }` objects or bare
// strings, and singular/plural fields inconsistently. Keep the schema permissive
// (passthrough, everything optional) and do the normalization by hand below.
const brevoAddressSchema = z.union([
  z.string(),
  z.looseObject({ Address: z.string().optional(), Name: z.string().nullable().optional() }),
]);

const brevoAttachmentSchema = z.looseObject({
  Name: z.string().optional(),
  ContentType: z.string().optional(),
  ContentLength: z.number().optional(),
  ContentID: z.string().nullable().optional(),
  ContentId: z.string().nullable().optional(),
  DownloadToken: z.string().optional(),
});

const brevoItemSchema = z.looseObject({
  Uuid: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  MessageId: z.string().optional(),
  InReplyTo: z.string().nullable().optional(),
  References: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  From: brevoAddressSchema.nullable().optional(),
  To: z.union([brevoAddressSchema, z.array(brevoAddressSchema)]).nullable().optional(),
  Cc: z.union([brevoAddressSchema, z.array(brevoAddressSchema)]).nullable().optional(),
  ReplyTo: brevoAddressSchema.nullable().optional(),
  Subject: z.string().nullable().optional(),
  SentAtDate: z.string().nullable().optional(),
  SpamScore: z.number().nullable().optional(),
  RawHtmlBody: z.string().nullable().optional(),
  RawTextBody: z.string().nullable().optional(),
  ExtractedMarkdownMessage: z.string().nullable().optional(),
  ExtractedMarkdownSignature: z.string().nullable().optional(),
  Attachments: z.array(brevoAttachmentSchema).nullable().optional(),
});

const brevoEnvelopeSchema = z.object({
  items: z.array(brevoItemSchema),
});

type BrevoAddress = z.infer<typeof brevoAddressSchema>;
type BrevoItem = z.infer<typeof brevoItemSchema>;

// ============================================================================
// Normalization helpers
// ============================================================================

function normalizeAddress(value: BrevoAddress | null | undefined): { address: string; name: string | null } | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const address = value.trim();
    return address.length > 0 ? { address, name: null } : null;
  }
  const address = value.Address?.trim();
  if (!address) return null;
  return { address, name: value.Name ?? null };
}

function normalizeAddressList(
  value: BrevoAddress | BrevoAddress[] | null | undefined,
): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) => normalizeAddress(entry))
    .filter((entry): entry is { address: string; name: string | null } => entry !== null)
    .map((entry) => entry.address);
}

function normalizeReferences(value: string | string[] | null | undefined): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const joined = value.map((s) => s.trim()).filter(Boolean).join(' ');
    return joined.length > 0 ? joined : null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstString(value: string | string[] | null | undefined): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.length > 0 ? value : null;
}

function normalizeAttachments(
  attachments: BrevoItem['Attachments'],
): NormalizedInboundAttachment[] {
  if (!attachments) return [];
  const normalized: NormalizedInboundAttachment[] = [];
  for (const att of attachments) {
    const downloadToken = att.DownloadToken;
    // No token → bytes are unfetchable; skip the descriptor (it would never link).
    if (!downloadToken) continue;
    normalized.push({
      name: att.Name ?? 'attachment',
      contentType: att.ContentType ?? 'application/octet-stream',
      contentLength: att.ContentLength ?? 0,
      contentId: att.ContentID ?? att.ContentId ?? null,
      downloadToken,
    });
  }
  return normalized;
}

function normalizeItem(item: BrevoItem): NormalizedInboundMessage | null {
  // MessageId is the dedup key + threading anchor; an item without one cannot be
  // safely stored (no idempotency). Skip it rather than fabricate an id.
  if (!item.MessageId) return null;

  const from = normalizeAddress(item.From) ?? { address: '', name: null };

  return {
    externalMessageId: item.MessageId,
    providerUuid: firstString(item.Uuid),
    inReplyTo: emptyToNull(item.InReplyTo),
    references: normalizeReferences(item.References),
    from,
    to: normalizeAddressList(item.To),
    cc: normalizeAddressList(item.Cc),
    replyTo: normalizeAddress(item.ReplyTo)?.address ?? null,
    subject: emptyToNull(item.Subject),
    strippedText: emptyToNull(item.ExtractedMarkdownMessage) ?? emptyToNull(item.RawTextBody),
    rawText: emptyToNull(item.RawTextBody),
    rawHtml: emptyToNull(item.RawHtmlBody),
    sentAt: emptyToNull(item.SentAtDate),
    spamScore: item.SpamScore ?? null,
    attachments: normalizeAttachments(item.Attachments),
  };
}

// ============================================================================
// Parser (pure — no network, no DB)
// ============================================================================

/**
 * Parse a Brevo inbound-parsing webhook payload (`{ items: [...] }`) into the
 * provider-agnostic normalized shape. Total (never throws) → returns a Result.
 *
 * Items without a `MessageId` are dropped (no dedup key); a payload with a valid
 * envelope but zero usable items returns an empty array, not an error.
 */
export function parseBrevoInbound(
  payload: unknown,
): Result<NormalizedInboundMessage[], MailInboundParseError> {
  const parsed = brevoEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return err({
      key: 'mail_inbound_parse_error',
      message: `Invalid Brevo inbound payload: ${parsed.error.message}`,
    });
  }

  const messages: NormalizedInboundMessage[] = [];
  for (const item of parsed.data.items) {
    const normalized = normalizeItem(item);
    if (normalized) messages.push(normalized);
  }

  return ok(messages);
}
