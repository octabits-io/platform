import { describe, it, expect } from 'vitest';
import { parseBrevoInbound } from './BrevoInboundProvider';
import { brevoInboundSample as samplePayload } from './__fixtures__/brevo-inbound.sample';

describe('parseBrevoInbound', () => {
  it('parses the sample payload into normalized messages', () => {
    const result = parseBrevoInbound(samplePayload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);

    const [first] = result.value;

    // First item: full object addresses, tagged To, extracted markdown, attachment.
    expect(first!.externalMessageId).toBe('<CADnmShjQ7y9w@mail.gmail.com>');
    expect(first!.providerUuid).toBe('a1b2c3d4-0000-1111-2222-333344445555');
    expect(first!.inReplyTo).toBe('<reply-anchor-001@inbound.example.com>');
    expect(first!.references).toBe(
      '<root-000@mail.example.com> <reply-anchor-001@inbound.example.com>',
    );
    expect(first!.from).toEqual({ address: 'guest@example.com', name: 'Jane Guest' });
    expect(first!.to).toEqual([
      'reply+19283746.42.0a1b2c3d4e5f60718293a4b5@inbound.example.com',
    ]);
    expect(first!.cc).toEqual(['cc-person@example.com']);
    expect(first!.replyTo).toBe('guest@example.com');
    expect(first!.subject).toBe('Re: Your enquiry');
    // Prefer ExtractedMarkdownMessage over the quoted raw text.
    expect(first!.strippedText).toBe('Hi, sounds good!');
    expect(first!.rawText).toBe('Hi, sounds good!\n\n> previous message');
    expect(first!.spamScore).toBe(0.3);

    expect(first!.attachments).toHaveLength(1);
    expect(first!.attachments[0]).toEqual({
      name: 'passport.pdf',
      contentType: 'application/pdf',
      contentLength: 84211,
      contentId: '<att-001>',
      downloadToken: 'dl-token-passport-abc123',
    });
  });

  it('handles bare-string addresses and missing optionals', () => {
    const result = parseBrevoInbound(samplePayload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const second = result.value[1]!;
    expect(second.externalMessageId).toBe('<second-item-9876@mail.example.com>');
    expect(second.from).toEqual({ address: 'bare-string@example.com', name: null });
    expect(second.to).toEqual(['ops@inbound.example.com']);
    expect(second.cc).toEqual([]);
    expect(second.providerUuid).toBeNull();
    expect(second.inReplyTo).toBeNull();
    expect(second.references).toBeNull();
    expect(second.replyTo).toBeNull();
    expect(second.spamScore).toBeNull();
    // No ExtractedMarkdownMessage → falls back to RawTextBody.
    expect(second.strippedText).toBe('Just a plain message with no extracted markdown.');
    expect(second.attachments).toEqual([]);
  });

  it('drops items without a parseable From instead of fabricating an empty sender', () => {
    const result = parseBrevoInbound({
      items: [
        { MessageId: '<no-from@example.com>', Subject: 'missing From' },
        { MessageId: '<empty-from@example.com>', From: '   ', Subject: 'blank From' },
        { MessageId: '<obj-empty-from@example.com>', From: { Name: 'Ghost' }, Subject: 'no Address' },
        { MessageId: '<ok@example.com>', From: 'y@example.com' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.externalMessageId).toBe('<ok@example.com>');
    expect(result.value[0]!.from).toEqual({ address: 'y@example.com', name: null });
  });

  it('drops items without a MessageId (no dedup key)', () => {
    const result = parseBrevoInbound({
      items: [
        { From: 'x@example.com', Subject: 'no id' },
        { MessageId: '<has-id@example.com>', From: 'y@example.com' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.externalMessageId).toBe('<has-id@example.com>');
  });

  it('drops attachments without a download token', () => {
    const result = parseBrevoInbound({
      items: [
        {
          MessageId: '<att-test@example.com>',
          From: 'x@example.com',
          Attachments: [
            { Name: 'no-token.pdf', ContentType: 'application/pdf', ContentLength: 10 },
            { Name: 'ok.pdf', ContentType: 'application/pdf', ContentLength: 20, DownloadToken: 'tok' },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.attachments).toHaveLength(1);
    expect(result.value[0]!.attachments[0]!.name).toBe('ok.pdf');
  });

  it('returns an empty array for a valid envelope with no items', () => {
    const result = parseBrevoInbound({ items: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns a parse error for a malformed envelope', () => {
    const result = parseBrevoInbound({ notItems: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.key).toBe('mail_inbound_parse_error');
  });

  it('returns a parse error for a non-object payload', () => {
    expect(parseBrevoInbound('garbage').ok).toBe(false);
    expect(parseBrevoInbound(null).ok).toBe(false);
  });
});
