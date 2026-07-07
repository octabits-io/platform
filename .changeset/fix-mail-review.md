---
'@octabits-io/mail': minor
---

Security-review fixes across the dispatch pipeline, transports, and inbound handling.

- **Real BCC support**: `MailMessage` gains an optional `bcc?: string[]`; the `customer_and_notifications` delivery mode now routes the notifications copy via BCC instead of exposing it in the visible `To`. All transports map it (smtp → nodemailer `bcc` + envelope recipients, mailjet → `Bcc`, brevo → `bcc`, logger/memory record it); the dev-override wrapper drops BCC so redirected dev mail can't leak. `RenderedEmail` reports `bcc` too.
- **Recipient-smuggling / header-injection guard**: `createBaseMailService` refuses any To/BCC/Reply-To/Return-Path address containing `,` `;` `<` `>`, whitespace, control characters, or failing a light email-shape check (new `invalid_recipient` error key), and strips CR/LF from header-bound display strings (subject, from name, reply-to name — covering scope-derived `scopeName`/`subjectBrand`). Sanitization contract documented on `MailTransport`; helpers `isValidRecipientAddress`/`stripHeaderUnsafeChars` exported.
- **Attachment screening hardening**: `fileExtension` strips trailing dots/spaces (Windows drops them on save), so `invoice.exe.` / `invoice.exe ` screen as `exe`; default blocklist extended with `xll`, `iso`, `img`, `chm`, `url`, `vhd`, `vhdx`. Documented that `maxPerMessage` is caller-enforced (not checked per attachment).
- **onSend audit completeness**: refusals (missing template, `mail_not_configured`, invalid recipient, fallback disabled) now fire the `onSend` hook with the error result and `message: undefined` (hook signature widened accordingly), plus a `logger.warn` for `mail_not_configured` refusals.
- **Missing-email guard**: user-classified params without an `email` now return `invalid_recipient` instead of sending `to: [undefined]`.
- **Brevo inbound**: items whose `From` cannot be parsed are dropped like MessageId-less items instead of emitting a fabricated empty sender; documented that Brevo does not sign webhooks and endpoint authentication is the consumer's responsibility.
- **HTTP timeouts**: Brevo requests carry a per-request `AbortSignal.timeout` (default 30s, `timeoutMs` on `BrevoCredentials`); the Mailjet client is connected with a request timeout (default 30s, `timeoutMs` on `MailjetCredentials`).
- **SMTP config unification**: `createSmtpTransporter` and `verifySmtpConnection` share one transport-options builder, so verify validates the exact send configuration (STARTTLS required whenever implicit TLS is off).
- **Docs**: corrected the "root entry is dependency-free" claim (root uses `@octabits-io/foundation` at runtime, a required peer); documented that `transportFactory` is invoked per send and should memoize transports by config identity.
