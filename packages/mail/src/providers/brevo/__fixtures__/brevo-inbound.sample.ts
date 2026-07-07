/**
 * Sample Brevo inbound-parsing webhook payload used by the parser tests.
 *
 * - Item 1 exercises object-form addresses, a tagged `reply+…` To, an
 *   extracted-markdown body distinct from the quoted raw text, and an attachment.
 * - Item 2 exercises bare-string addresses and mostly-missing optionals.
 */
export const brevoInboundSample = {
  items: [
    {
      Uuid: ['a1b2c3d4-0000-1111-2222-333344445555'],
      MessageId: '<CADnmShjQ7y9w@mail.gmail.com>',
      InReplyTo: '<reply-anchor-001@inbound.example.com>',
      References: '<root-000@mail.example.com> <reply-anchor-001@inbound.example.com>',
      From: { Address: 'guest@example.com', Name: 'Jane Guest' },
      To: [
        { Address: 'reply+19283746.42.0a1b2c3d4e5f60718293a4b5@inbound.example.com', Name: 'Support Reply' },
      ],
      Cc: [{ Address: 'cc-person@example.com', Name: null }],
      ReplyTo: { Address: 'guest@example.com', Name: 'Jane Guest' },
      SentAtDate: '2026-05-29T10:15:00Z',
      Subject: 'Re: Your enquiry',
      SpamScore: 0.3,
      RawHtmlBody: '<p>Hi, sounds good!</p><blockquote>previous message</blockquote>',
      RawTextBody: 'Hi, sounds good!\n\n> previous message',
      ExtractedMarkdownMessage: 'Hi, sounds good!',
      ExtractedMarkdownSignature: 'Jane',
      Attachments: [
        {
          Name: 'passport.pdf',
          ContentType: 'application/pdf',
          ContentLength: 84211,
          ContentID: '<att-001>',
          DownloadToken: 'dl-token-passport-abc123',
        },
      ],
    },
    {
      MessageId: '<second-item-9876@mail.example.com>',
      From: 'bare-string@example.com',
      To: 'ops@inbound.example.com',
      Subject: 'No tag, plain inbound',
      RawTextBody: 'Just a plain message with no extracted markdown.',
    },
  ],
};
