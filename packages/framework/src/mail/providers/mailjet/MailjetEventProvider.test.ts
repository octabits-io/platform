/**
 * Unit tests for the Mailjet Event API parser. Pure — no DB, no network.
 * Payload shapes are taken verbatim from Mailjet's Event API guide.
 */

import { describe, it, expect } from 'vitest';
import { parseMailjetEvents, mapMailjetEventToDeliveryStatus } from './MailjetEventProvider';

describe('mapMailjetEventToDeliveryStatus', () => {
  it('treats `sent` as delivered', () => {
    // Mailjet has no `delivered` event — `sent` means the recipient's mail
    // server accepted the message, which is the fact Brevo reports as delivered.
    expect(mapMailjetEventToDeliveryStatus('sent')).toBe('delivered');
  });

  it('splits bounce on the hard_bounce flag', () => {
    expect(mapMailjetEventToDeliveryStatus('bounce', { hardBounce: true })).toBe('bounced');
    expect(mapMailjetEventToDeliveryStatus('bounce', { hardBounce: false })).toBe('failed');
    // Absent flag is the conservative read: a soft/transient failure.
    expect(mapMailjetEventToDeliveryStatus('bounce')).toBe('failed');
  });

  it('maps terminal rejections to bounced', () => {
    expect(mapMailjetEventToDeliveryStatus('blocked')).toBe('bounced');
    expect(mapMailjetEventToDeliveryStatus('spam')).toBe('bounced');
  });

  it('returns null for engagement events', () => {
    expect(mapMailjetEventToDeliveryStatus('open')).toBeNull();
    expect(mapMailjetEventToDeliveryStatus('click')).toBeNull();
    expect(mapMailjetEventToDeliveryStatus('unsub')).toBeNull();
  });
});

describe('parseMailjetEvents', () => {
  it('correlates on Message_GUID, not the numeric MessageID', () => {
    const result = parseMailjetEvents({
      event: 'sent',
      time: 1433333949,
      MessageID: 19421777835146490,
      Message_GUID: '1ab23cd4-e567-8901-2345-6789f0gh1i2j',
      email: 'guest@example.com',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      externalMessageId: '1ab23cd4-e567-8901-2345-6789f0gh1i2j',
      event: 'sent',
      deliveryStatus: 'delivered',
    });
  });

  it('prefers the SMTP comment over the terse error as the reason', () => {
    const result = parseMailjetEvents({
      event: 'bounce',
      MessageID: 13792286917004336,
      Message_GUID: 'guid-1',
      email: 'bounce@mailjet.com',
      blocked: false,
      hard_bounce: true,
      error_related_to: 'recipient',
      error: 'user unknown',
      comment: 'Host or domain name not found. Name service error for name=x type=A: Host not found',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({
      externalMessageId: 'guid-1',
      deliveryStatus: 'bounced',
      reason: 'Host or domain name not found. Name service error for name=x type=A: Host not found',
    });
  });

  it('falls back to the error when no comment is present', () => {
    const result = parseMailjetEvents({
      event: 'blocked',
      Message_GUID: 'guid-2',
      error: 'user unknown',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toMatchObject({ deliveryStatus: 'bounced', reason: 'user unknown' });
  });

  it('parses a grouped batch (Mailjet posts an array when grouping is enabled)', () => {
    const result = parseMailjetEvents([
      { event: 'sent', Message_GUID: 'g1' },
      { event: 'bounce', Message_GUID: 'g2', hard_bounce: true },
      { event: 'open', Message_GUID: 'g3' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    expect(result.value.map(e => e.deliveryStatus)).toEqual(['delivered', 'bounced', null]);
  });

  it('falls back to MessageID when the GUID is missing', () => {
    // Sent as a JSON string here on purpose: Mailjet's real numeric ids run past
    // 2^53, so by the time a number reaches us JSON.parse has already rounded it.
    // That lossiness is why Message_GUID is the correlation key and this is only
    // a last resort.
    const result = parseMailjetEvents({ event: 'sent', MessageID: '19421777835146490' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.externalMessageId).toBe('19421777835146490');
  });

  it('drops events with no correlation id or no event name', () => {
    const result = parseMailjetEvents([
      { event: 'sent' },
      { Message_GUID: 'g1' },
      { event: 'sent', Message_GUID: 'g2' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.externalMessageId).toBe('g2');
  });

  it('keeps unknown fields from breaking the parse', () => {
    const result = parseMailjetEvents({
      event: 'sent',
      Message_GUID: 'g1',
      some_future_mailjet_field: { nested: true },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(1);
  });

  it('errors on a payload that is neither an object nor an array', () => {
    const result = parseMailjetEvents('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('mail_event_parse_error');
  });
});
