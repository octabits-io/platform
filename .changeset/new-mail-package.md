---
"@octabits-io/mail": minor
---

Add `@octabits-io/mail`: a provider-agnostic mail transport contract plus a set
of deliberately-dumb outbound transports.

- Base contract — `MailTransport` (`{ type, send(message) }`), the
  provider-agnostic `MailMessage`/`MailAttachment` shapes, and the mail error
  types (`MailConfigurationError`/`MailDeliveryError`/`MailTemplateError`/
  `MailNotConfiguredError`, plus `SentMailInfo`/`RenderedEmail`). `send` returns
  `Result<SentMailInfo, MailDeliveryError>` from `@octabits-io/foundation`.
- Outbound transports — `createSmtpTransport` (nodemailer; the only transport
  that honors `returnPath` via the SMTP envelope), `createMailjetTransport`
  (node-mailjet; `messageId: null`), `createBrevoTransport` (wretch; surfaces a
  real Message-ID), `createLoggerTransport` (dev), `createMemoryTransport`
  (test, with inspection helpers).
- Each real provider also ships a low-level client factory
  (`createSmtpTransporter`/`createMailjetClient`/`createBrevoClient`) and a
  connection verifier (`verifySmtpConnection`/`verifyMailjetConnection`/
  `verifyBrevoConnection`).

Generic and dependency-injected: send behavior is byte-for-byte identical to the
originating implementation, the logger is injected, and all config shapes are
credential-only (no environment coupling). Business logic (templating, recipient
resolution, bounce/inbound correlation) is expected to live in a higher-level
mail service above these transports.
