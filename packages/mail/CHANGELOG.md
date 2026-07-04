# @octabits-io/mail

## 0.2.0

### Minor Changes

- [`53db7bc`](https://github.com/octabits-io/platform/commit/53db7bcc18905aa9bd0efc1004eac11ec6d9bab4) - Add `@octabits-io/mail`: a provider-agnostic mail transport contract plus a set
  of deliberately-dumb outbound transports.

  The root entry (`.`) is dependency-free — contract, error taxonomy, and the
  logger/memory transports. Vendor transports live behind subpath exports
  (`./smtp`, `./mailjet`, `./brevo`), with their SDKs (`nodemailer`,
  `node-mailjet`, `wretch`) declared as **optional peer dependencies** so
  consumers only install and load the ones they use.
  `@octabits-io/foundation` is a required **peer dependency** (static range
  `>=0.2.0 <1`): its `Result` types are part of the `send()` contract, so the
  consumer must share a single foundation instance.

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
