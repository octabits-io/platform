# @octabits-io/framework/mail

Provider-agnostic mail transport contract plus a set of deliberately-dumb
outbound transports. Each transport does exactly one thing — deliver a
normalized `MailMessage` — and returns a `Result<SentMailInfo, MailDeliveryError>`.
All business logic (config resolution, templating, recipient resolution, bounce
correlation) is expected to live in a higher-level mail service that sits above
these transports.

## Install

```bash
pnpm add @octabits-io/framework/mail
# plus the SDK for each vendor transport you actually use:
pnpm add nodemailer      # for @octabits-io/framework/mail/smtp
pnpm add node-mailjet    # for @octabits-io/framework/mail/mailjet
pnpm add wretch          # for @octabits-io/framework/mail/brevo (transport)
pnpm add zod             # for @octabits-io/framework/mail/brevo inbound/event parsers
```

`@octabits-io/framework` (`Result`, `Logger`) is a required peer dependency
used by the root entry at runtime. The vendor SDKs are **optional peer
dependencies**: the root entry (`.`) is vendor-free (contract + logger/memory
transports, no provider SDKs), and each vendor transport lives behind its own
subpath so you only install and load the SDKs you use.

## The contract

```ts
import type { MailTransport, MailMessage } from '@octabits-io/framework/mail';

interface MailTransport {
  readonly type: string;
  send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>>;
}
```

A `MailMessage` is fully provider-agnostic: `from`, `to[]`, optional `bcc[]`
(blind-carbon-copy — delivered but never shown in visible headers), optional
`replyTo`, optional `returnPath` (SMTP envelope sender), `subject`, `text`,
`html`, and optional `attachments` (raw bytes; each transport re-encodes as
needed).

`SentMailInfo.messageId` is the provider's RFC 5322 Message-ID when available
(SMTP and Brevo surface it; Mailjet does not → `null`).

## Transports

| Factory | Import from | SDK peer | Notes |
| --- | --- | --- | --- |
| `createSmtpTransport({ smtp, logger })` | `@octabits-io/framework/mail/smtp` | `nodemailer` | The only transport that honors `returnPath` via the SMTP envelope. |
| `createMailjetTransport({ mailjet, logger })` | `@octabits-io/framework/mail/mailjet` | `node-mailjet` | Send v3.1 API; `messageId` is always `null`. |
| `createBrevoTransport({ brevo, logger })` | `@octabits-io/framework/mail/brevo` | `wretch` | Returns a real `messageId` → suitable for delivery/bounce tracking. |
| `createLoggerTransport({ logger })` | `@octabits-io/framework/mail` | — | Logs instead of sending (dev). Synthesizes a dev Message-ID. |
| `createMemoryTransport()` | `@octabits-io/framework/mail` | — | Captures messages in memory for tests, with inspection helpers. |

Each provider also ships a low-level client factory
(`createSmtpTransporter` / `createMailjetClient` / `createBrevoClient`) and a
connection verifier (`verifySmtpConnection` / `verifyMailjetConnection` /
`verifyBrevoConnection`).

**SMTP TLS posture.** With implicit TLS off (`secure` unset/false), STARTTLS is
required by default — the connection fails rather than downgrade to plaintext.
Set `requireTLS: false` in the `smtp` config to reach a plaintext dev/test
server (Mailpit, Mailhog) that offers no TLS. Never disable it in production.

## Example

```ts
import { createSmtpTransport } from '@octabits-io/framework/mail/smtp';

const transport = createSmtpTransport({
  smtp: { host: 'smtp.example.com', port: 587, auth: { user, pass } },
  logger,
});

const result = await transport.send({
  from: { address: 'noreply@example.com', name: 'My App' },
  to: ['user@example.com'],
  subject: 'Hello',
  text: 'Plain text content',
  html: '<p>HTML content</p>',
});

if (!result.ok) {
  logger.error(result.error.message);
}
```

## Dispatch pipeline

`createBaseMailService` is the higher-level service the contract mentions: it
turns typed send-params into a delivered `MailMessage`. (The matching config
fragment — a discriminated union over the four shipped transports whose fields
spread straight into this service — ships as `MAIL_CONFIG_SCHEMA` in
[`@octabits-io/framework/config-schema`](./foundation.md).) It renders a template,
resolves per-scope config, picks recipients by delivery mode, selects a
transport (a scope's own mail server vs a platform fallback), applies redirect
subject-prefixing and an optional dev-override, sends, and fires an `onSend`
hook. It stays vendor-free — every coupling is an injected seam:

| Seam | Shape | Responsibility |
| --- | --- | --- |
| `templates` | `MailTemplateRegistry<TOverrides>` | `type` → template builder (`buildSubject`/`buildHtmlContent`/`buildTextContent`). |
| `classify` | `(params) => 'user' \| 'system'` | User- vs operator-directed routing. Defaults to `recipient === 'admin'` → `system`. |
| `configReader` | `(params) => Promise<ResolvedMailConfig \| undefined>` | Per-scope locale, opaque overrides, delivery mode, notifications inbox, mail-server config. `undefined` → global transport + platform identity (dev/test). |
| `transportFactory` | `(serverConfig) => MailTransport` | Builds a vendor transport from a scope's mail-server config. Where the SDK imports live. |

The service is generic over the caller's params union (`extends BaseMailParams`),
an opaque per-render `TOverrides` (passed straight to the template builder), and
the scoped mail-server config type (`extends ScopedMailServerConfig`, i.e. at
least `{ fromAddress, fromName? }`). Locale is an opaque `string` resolved by the
`configReader`.

```ts
import {
  createBaseMailService,
  type MailTemplateRegistry,
  type MailConfigReader,
} from '@octabits-io/framework/mail';

const service = createBaseMailService({
  platformFromAddress: 'noreply@example.com',
  platformFromName: 'Example',       // also the "<scope> via <brand>" fallback brand
  templates,                          // MailTemplateRegistry keyed by params.type
  configReader,                       // resolves scoped config; omit for dev/test
  transportFactory,                   // builds a vendor transport from a scoped server config
  transport: createMemoryTransport(), // global/platform transport
  logger,
});

await service.send({ type: 'welcome', email: 'user@example.com' });
```

Routing at a glance:

- **Scoped server active** (`configReader` returns a `mailServerConfig` and
  `mailServerEnabled !== false`, and a `transportFactory` is wired) → send via
  that transport; `From` is the server's own address.
- **Platform fallback** (no active server, `platformFallbackEnabled !== false`)
  → send via the global `transport`; `From` becomes `"<scopeName> via <brand>"`
  and `Reply-To` is the scope's notifications inbox (never a platform address;
  omitted when unset).
- **Refused** (no active server, fallback disabled) → `mail_not_configured`.

Delivery mode (`default` | `notifications_only` | `customer_and_notifications`)
controls user-mail recipients; `forceNotificationsOnlyDelivery` overrides it for
all user mail (test mail with `bypassDeliveryMode` exempt). A caller-supplied
`params.replyTo`/`params.returnPath` (e.g. a tagged inbound address) always wins
over the computed fallback. `createDevOverrideMailTransport(inner, addr, logger)`
wraps any transport to redirect every recipient to a single dev address.

> The service never imports a vendor SDK. A ready-made `transportFactory` that
> wires SMTP + Mailjet + Brevo would pull all three optional peers, so it is left
> to the consumer — build one from the `createSmtpTransport` / `createMailjetTransport`
> / `createBrevoTransport` factories (imported from their subpaths) switched on
> your own config's provider field.

### Render now, deliver later (`render` + `dispatchRendered`)

`render(params)` produces the `RenderedEmail` (subject/html/text + resolved
recipients) without contacting any transport, and `dispatchRendered(params,
rendered)` delivers a `RenderedEmail` verbatim — the content and recipients are
sent as-is, while transport/From/fallback routing is **recomputed** via a fresh
`configReader(params)` read (the template is never rebuilt). The
header-injection guard runs again on dispatch, before any transport contact.

Together they let a consumer split render from delivery: retry a previously
rendered message, defer a send, or build a **hold-for-review** flow that the
consumer owns end-to-end — render, park the `RenderedEmail` in your own outbox,
then re-dispatch it after approval. The service stays a dispatcher; the review
workflow, its storage, and its fail-closed policy live in the consumer.

```ts
// render + park (consumer's own outbox / review UI)
const rendered = await service.render(params);
if (rendered.ok) await outbox.park({ params, rendered: rendered.value });

// …later, after a reviewer approves — routing re-resolved against current config
await service.dispatchRendered(params, approvedRendered);
```

## Tagged reply addresses

`replyAddress` builds and parses tagged inbound addresses of the form
`reply+<scopeKey>.<resourceId>.<tag>@<domain>` (and `bounce+…` for the
Return-Path). It is pure string handling — no crypto; produce/verify the `<tag>`
with your own signing service over `replyAddressMessage(scopeKey, resourceId)`.
`scopeKey` selects the signing key/partition (may contain `.`); `resourceId` is
an opaque application id (must not contain `.`). Because `parseReplyAddress`
treats `resourceId` as an opaque string, a consumer whose id is more constrained
(e.g. a positive integer) should re-apply its own validation/coercion on the
parsed value — the package will not reject a well-formed-but-out-of-domain id.

```ts
import { buildReplyAddress, parseReplyAddress } from '@octabits-io/framework/mail';

const addr = buildReplyAddress({ scopeKey: 'acct-42', resourceId: 'thread-9', tag, domain: 'inbound.example.com' });
const parts = parseReplyAddress({ addresses: message.to, domain: 'inbound.example.com' });
// → { scopeKey: 'acct-42', resourceId: 'thread-9', tag } | null
```

## Inbound + delivery events

The root contract carries the provider-agnostic normalized shapes so any inbound
provider can target them: `NormalizedInboundMessage` / `NormalizedInboundAttachment`
(inbound parsing) and `DeliveryStatus` / `NormalizedDeliveryEvent` (transactional
delivery events). The Brevo parsers that emit these live behind the `./brevo`
subpath (they use `zod`, an optional peer):

```ts
import { parseBrevoInbound, parseBrevoEvents, mapBrevoEventToDeliveryStatus } from '@octabits-io/framework/mail/brevo';

const inbound = parseBrevoInbound(webhookBody);   // Result<NormalizedInboundMessage[], MailInboundParseError>
const events = parseBrevoEvents(webhookBody);      // Result<NormalizedDeliveryEvent[], MailEventParseError>
```

These parsers emit the **package-native** `NormalizedInboundMessage` /
`DeliveryStatus` shapes, not your persistence model. A consumer with its own
delivery-status enum, extra fields (e.g. a provider download token on an
attachment), or a different inbound shape maps at the boundary — keep that
adapter thin and cross-check the event-string → `DeliveryStatus` coverage
against your enum, since this code path is webhook-behavior-sensitive.

`screenInboundAttachment` (root export) enforces a cheap, dependency-free policy
on untrusted inbound attachments — a size ceiling, an executable/macro extension
blocklist, and a MIME blocklist. The defaults are exported as constants and can
be overridden per call:

```ts
import { screenInboundAttachment } from '@octabits-io/framework/mail';

const verdict = screenInboundAttachment({ name: 'invoice.pdf', contentType: 'application/pdf', contentLength: 12_345 });
if (verdict.blocked) reject(verdict.reason);       // e.g. tighten with { maxBytes: 5 * 1024 * 1024 }
```

## Testing

Use `createMemoryTransport()` to assert on outgoing mail without a network:

```ts
const transport = createMemoryTransport();
await transport.send({ from: { address: 'a@b.c' }, to: ['x@y.z'], subject: 'Hi', text: '', html: '' });
expect(transport.count()).toBe(1);
expect(transport.getLastMessage()?.to).toContain('x@y.z');
```

## License

MIT
