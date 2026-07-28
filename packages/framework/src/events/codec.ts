/**
 * The notification-channel wire codec — the one place the payload format of
 * cross-process event notifications is defined.
 *
 * Both message kinds are JSON with a `k` discriminator:
 *
 * - `{ k: 'ptr', s: <scopeKey>, q: <seq> }` — durable-lane pointer. The row
 *   is the fact; the notification only says "outbox row q for scope s exists".
 * - `{ k: 'evt', e: <envelope> }` — ephemeral-lane event, carried inline.
 *
 * `drizzle/event-outbox` (the send side) imports these encoders directly —
 * shared code, not a structurally-duplicated convention, because a *format*
 * that drifts between encoder and decoder fails silently. This file is
 * dependency-free so that import costs nothing.
 *
 * Postgres NOTIFY caps payloads at ~8000 bytes; {@link encodeInlineEvent}
 * throws past {@link MAX_NOTIFY_PAYLOAD_BYTES} because an oversized ephemeral
 * event is a programming error (payload discipline: identifiers, not
 * entities), not a runtime condition to degrade around.
 */
import type { EventEnvelope } from './types.ts';

/** Safety margin under Postgres' ~8000-byte NOTIFY payload limit. */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7800;

/** A decoded notification: a durable pointer or an inline ephemeral event. */
export type DecodedEventNotification =
  | { kind: 'pointer'; scopeKey: string; seq: number }
  | { kind: 'event'; envelope: EventEnvelope };

/** Encode a durable-lane pointer notification. */
export function encodeEventPointer(scopeKey: string, seq: number): string {
  return JSON.stringify({ k: 'ptr', s: scopeKey, q: seq });
}

/** Encode an ephemeral-lane inline event notification. Throws if oversized. */
export function encodeInlineEvent(envelope: EventEnvelope): string {
  const payload = JSON.stringify({ k: 'evt', e: envelope });
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (bytes > MAX_NOTIFY_PAYLOAD_BYTES) {
    throw new Error(
      `Ephemeral event '${envelope.type}' (${envelope.id}) encodes to ${bytes} bytes, ` +
        `over the ${MAX_NOTIFY_PAYLOAD_BYTES}-byte notification limit. ` +
        'Ephemeral payloads must stay small (identifiers, not entities) — ' +
        'or use the durable lane, which sends only a pointer.',
    );
  }
  return payload;
}

/**
 * Decode a raw notification payload. Returns `null` for anything that is not
 * a well-formed event notification — the channel may be shared with other
 * traffic, so unknown payloads are ignored, not errors.
 */
export function decodeEventNotification(payload: string): DecodedEventNotification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;

  if (message['k'] === 'ptr') {
    const scopeKey = message['s'];
    const seq = message['q'];
    if (typeof scopeKey !== 'string' || typeof seq !== 'number' || !Number.isInteger(seq)) {
      return null;
    }
    return { kind: 'pointer', scopeKey, seq };
  }

  if (message['k'] === 'evt') {
    const envelope = message['e'];
    if (typeof envelope !== 'object' || envelope === null) return null;
    const candidate = envelope as Record<string, unknown>;
    if (
      typeof candidate['id'] !== 'string' ||
      typeof candidate['type'] !== 'string' ||
      typeof candidate['scopeKey'] !== 'string' ||
      typeof candidate['at'] !== 'string' ||
      (candidate['lane'] !== 'durable' && candidate['lane'] !== 'ephemeral')
    ) {
      return null;
    }
    return { kind: 'event', envelope: envelope as EventEnvelope };
  }

  return null;
}
