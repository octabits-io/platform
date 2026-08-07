---
'@octabits-io/framework': minor
---

Make Mailjet sends observable after hand-off.

The Mailjet transport returned `messageId: null` and discarded the rest of the
Send v3.1 response, so a Mailjet-backed send had no handle at all tying it to the
provider's later delivery events — a bounce was indistinguishable from a
delivery, forever.

- `SentMailInfo` gains `providerMessageId`: an opaque, provider-scoped handle for
  correlating delivery events, kept deliberately separate from `messageId` (the
  RFC 5322 header id, which is the only thing that can thread an inbound reply).
  SMTP and Brevo set both to the same value; Mailjet now returns its
  `MessageUUID` as `providerMessageId` and still `null` as `messageId`. The field
  is optional, so existing `MailTransport` implementations keep compiling —
  consumers should read `providerMessageId ?? messageId`.
- New `parseMailjetEvents` / `mapMailjetEventToDeliveryStatus` exported from
  `@octabits-io/framework/mail/mailjet`, mirroring the Brevo event parser and
  emitting the same `NormalizedDeliveryEvent`. Events correlate on
  `Message_GUID` (the value the Send API returned as `MessageUUID`). Mailjet's
  `sent` maps to `delivered` — it has no separate delivered event, and `sent`
  means the recipient's mail server accepted the message; `bounce` splits to
  `bounced`/`failed` on the `hard_bounce` flag; `blocked` and `spam` map to
  `bounced`.
