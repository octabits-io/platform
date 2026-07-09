# @octabits-io/mail

## 0.4.0

### Minor Changes

- [`e70e564`](https://github.com/octabits-io/platform/commit/e70e5644f9ec83eb4fa08cfc2085ab66dc68af3f) - Export `MAIL_DELIVERY_STATUSES`, a runtime tuple of the provider-agnostic delivery statuses (`['queued', 'sent', 'delivered', 'failed', 'bounced']`), from the root. `DeliveryStatus` is now derived from it (`(typeof MAIL_DELIVERY_STATUSES)[number]`), so the type and the runtime value are a single source of truth.

  Previously `DeliveryStatus` was a type-only union, forcing a consumer that stores delivery status in a database enum to hand-maintain a parallel string list and re-verify it against every provider mapping (e.g. `mapBrevoEventToDeliveryStatus`). Consumers can now derive their storage enum directly from the package — e.g. `pgEnum('message_delivery_status', MAIL_DELIVERY_STATUSES)` — collapsing that translation-and-verification surface to a compile-time `satisfies` check.

  Purely additive — the `DeliveryStatus` type is unchanged.

- [`f3b60e6`](https://github.com/octabits-io/platform/commit/f3b60e6f19d1fba0f5ed08d4051a21cc76cbe6bb) - Add `dispatchRendered(params, rendered)` to `createBaseMailService`, splitting rendering from delivery. `render(params)` already produced a `RenderedEmail` without sending; `dispatchRendered` now delivers one verbatim — the content and recipients are sent as-is while transport/From/fallback routing is recomputed via a fresh `configReader(params)` read (the template is never rebuilt), and the header-injection guard runs again before any transport contact.

  This lets a consumer render now and deliver later: retry a rendered message, defer a send, or build a hold-for-review flow the consumer owns end-to-end (render → park in its own outbox → re-dispatch after approval), without re-implementing the pipeline's routing/delivery half. Purely additive — existing `send()`/`render()` behavior is unchanged.

## 0.3.0

### Minor Changes

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Security-review fixes across the dispatch pipeline, transports, and inbound handling.

  - **Real BCC support**: `MailMessage` gains an optional `bcc?: string[]`; the `customer_and_notifications` delivery mode now routes the notifications copy via BCC instead of exposing it in the visible `To`. All transports map it (smtp → nodemailer `bcc` + envelope recipients, mailjet → `Bcc`, brevo → `bcc`, logger/memory record it); the dev-override wrapper drops BCC so redirected dev mail can't leak. `RenderedEmail` reports `bcc` too.
  - **Recipient-smuggling / header-injection guard**: `createBaseMailService` refuses any To/BCC/Reply-To/Return-Path address containing `,` `;` `<` `>`, whitespace, control characters, or failing a light email-shape check (new `invalid_recipient` error key), and strips CR/LF from header-bound display strings (subject, from name, reply-to name — covering scope-derived `scopeName`/`subjectBrand`). Sanitization contract documented on `MailTransport`; helpers `isValidRecipientAddress`/`stripHeaderUnsafeChars` exported.
  - **Attachment screening hardening**: `fileExtension` strips trailing dots/spaces (Windows drops them on save), so `invoice.exe.` / `invoice.exe ` screen as `exe`; default blocklist extended with `xll`, `iso`, `img`, `chm`, `url`, `vhd`, `vhdx`. Documented that `maxPerMessage` is caller-enforced (not checked per attachment).
  - **onSend audit completeness**: refusals (missing template, `mail_not_configured`, invalid recipient, fallback disabled) now fire the `onSend` hook with the error result and `message: undefined` (hook signature widened accordingly), plus a `logger.warn` for `mail_not_configured` refusals.
  - **Missing-email guard**: user-classified params without an `email` now return `invalid_recipient` instead of sending `to: [undefined]`.
  - **Brevo inbound**: items whose `From` cannot be parsed are dropped like MessageId-less items instead of emitting a fabricated empty sender; documented that Brevo does not sign webhooks and endpoint authentication is the consumer's responsibility.
  - **HTTP timeouts**: Brevo requests carry a per-request `AbortSignal.timeout` (default 30s, `timeoutMs` on `BrevoCredentials`); the Mailjet client is connected with a request timeout (default 30s, `timeoutMs` on `MailjetCredentials`).
  - **SMTP config unification**: `createSmtpTransporter` and `verifySmtpConnection` share one transport-options builder, so verify validates the exact send configuration (STARTTLS required whenever implicit TLS is off).
  - **Docs**: corrected the "root entry is dependency-free" claim (root uses `@octabits-io/foundation` at runtime, a required peer); documented that `transportFactory` is invoked per send and should memoize transports by config identity.

- [`ed7813e`](https://github.com/octabits-io/platform/commit/ed7813e8274c1246ab694703d59ced0839b2e5d3) - Transactional dispatch layer, inbound-mail contract, and email-ingress guardrails.

  - `createBaseMailService({ templates, configReader, transportFactory, ... })` — generic dispatch pipeline (template render → scoped config → recipient/delivery-mode resolution → transport selection with platform fallback → `onSend` hook), plus dev-override recipient redirection with subject prefixing. Template registry, classification, config lookup, and vendor transports are all injected seams; the root export stays vendor-free.
  - `buildReplyAddress`/`parseReplyAddress` — tagged `reply+<scopeKey>.<resourceId>.<tag>@domain` / `bounce+…` address handling.
  - Root contract types for inbound mail (`NormalizedInboundMessage`) and delivery events (`DeliveryStatus`, `NormalizedDeliveryEvent`); `./brevo` adds `parseBrevoInbound` and `parseBrevoEvents` + `mapBrevoEventToDeliveryStatus` normalizers (zod is a new optional peer, used only by `./brevo`).
  - `screenInboundAttachment`/`fileExtension` — inbound-attachment security policy (size/count ceilings, executable/macro extension + MIME blocklists), configurable with safe defaults.

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
