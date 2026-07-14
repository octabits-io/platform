/**
 * Unit tests for the Brevo transactional event parser. Pure — no DB, no network.
 */

import { describe, it, expect } from 'vitest';
import { parseBrevoEvents, mapBrevoEventToDeliveryStatus } from './BrevoEventProvider';

describe('mapBrevoEventToDeliveryStatus', () => {
  it('maps Brevo events to delivery statuses', () => {
    expect(mapBrevoEventToDeliveryStatus('delivered')).toBe('delivered');
    expect(mapBrevoEventToDeliveryStatus('hard_bounce')).toBe('bounced');
    expect(mapBrevoEventToDeliveryStatus('spam')).toBe('bounced');
    expect(mapBrevoEventToDeliveryStatus('blocked')).toBe('bounced');
    expect(mapBrevoEventToDeliveryStatus('invalid_email')).toBe('bounced');
    expect(mapBrevoEventToDeliveryStatus('soft_bounce')).toBe('failed');
    expect(mapBrevoEventToDeliveryStatus('deferred')).toBe('failed');
    expect(mapBrevoEventToDeliveryStatus('error')).toBe('failed');
  });

  it('returns null for non-delivery events', () => {
    expect(mapBrevoEventToDeliveryStatus('opened')).toBeNull();
    expect(mapBrevoEventToDeliveryStatus('click')).toBeNull();
    expect(mapBrevoEventToDeliveryStatus('request')).toBeNull();
    expect(mapBrevoEventToDeliveryStatus('unsubscribed')).toBeNull();
  });
});

describe('parseBrevoEvents', () => {
  it('parses a single event object with hyphenated message-id', () => {
    const result = parseBrevoEvents({ event: 'hard_bounce', 'message-id': '<m1@x>', reason: 'mailbox full' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      externalMessageId: '<m1@x>',
      event: 'hard_bounce',
      deliveryStatus: 'bounced',
      reason: 'mailbox full',
    });
  });

  it('falls back to camelCase messageId', () => {
    const result = parseBrevoEvents({ event: 'delivered', messageId: '<m2@x>' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.externalMessageId).toBe('<m2@x>');
    expect(result.value[0]?.deliveryStatus).toBe('delivered');
  });

  it('parses a bare array of events', () => {
    const result = parseBrevoEvents([
      { event: 'delivered', 'message-id': '<a@x>' },
      { event: 'soft_bounce', 'message-id': '<b@x>' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[1]?.deliveryStatus).toBe('failed');
  });

  it('parses { items: [...] } and { events: [...] } wrappers', () => {
    const items = parseBrevoEvents({ items: [{ event: 'delivered', 'message-id': '<c@x>' }] });
    expect(items.ok && items.value).toHaveLength(1);
    const events = parseBrevoEvents({ events: [{ event: 'spam', 'message-id': '<d@x>' }] });
    expect(events.ok && events.value).toHaveLength(1);
  });

  it('keeps non-delivery events but with a null status (handler skips them)', () => {
    const result = parseBrevoEvents({ event: 'opened', 'message-id': '<e@x>' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.deliveryStatus).toBeNull();
  });

  it('drops events missing a message-id or event name', () => {
    const result = parseBrevoEvents([
      { event: 'delivered' }, // no message-id
      { 'message-id': '<f@x>' }, // no event
      { event: 'delivered', 'message-id': '<g@x>' }, // valid
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.externalMessageId).toBe('<g@x>');
  });

  it('returns an error for a non-object/array payload', () => {
    expect(parseBrevoEvents('nope').ok).toBe(false);
    expect(parseBrevoEvents(42).ok).toBe(false);
  });
});
