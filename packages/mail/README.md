# @octabits-io/mail

Provider-agnostic mail transport contract plus a set of deliberately-dumb
outbound transports. Each transport does exactly one thing — deliver a
normalized `MailMessage` — and returns a `Result<SentMailInfo, MailDeliveryError>`.
All business logic (config resolution, templating, recipient resolution, bounce
correlation) is expected to live in a higher-level mail service that sits above
these transports.

## Install

```bash
pnpm add @octabits-io/mail
# plus the SDK for each vendor transport you actually use:
pnpm add nodemailer      # for @octabits-io/mail/smtp
pnpm add node-mailjet    # for @octabits-io/mail/mailjet
pnpm add wretch          # for @octabits-io/mail/brevo
```

`@octabits-io/foundation` (`Result`, `Logger`) is a required peer dependency.
The vendor SDKs are **optional peer dependencies**: the root entry (`.`) is
dependency-free (contract + logger/memory transports), and each vendor
transport lives behind its own subpath so you only install and load the SDKs
you use.

## The contract

```ts
import type { MailTransport, MailMessage } from '@octabits-io/mail';

interface MailTransport {
  readonly type: string;
  send(message: MailMessage): Promise<Result<SentMailInfo, MailDeliveryError>>;
}
```

A `MailMessage` is fully provider-agnostic: `from`, `to[]`, optional `replyTo`,
optional `returnPath` (SMTP envelope sender), `subject`, `text`, `html`, and
optional `attachments` (raw bytes; each transport re-encodes as needed).

`SentMailInfo.messageId` is the provider's RFC 5322 Message-ID when available
(SMTP and Brevo surface it; Mailjet does not → `null`).

## Transports

| Factory | Import from | SDK peer | Notes |
| --- | --- | --- | --- |
| `createSmtpTransport({ smtp, logger })` | `@octabits-io/mail/smtp` | `nodemailer` | The only transport that honors `returnPath` via the SMTP envelope. |
| `createMailjetTransport({ mailjet, logger })` | `@octabits-io/mail/mailjet` | `node-mailjet` | Send v3.1 API; `messageId` is always `null`. |
| `createBrevoTransport({ brevo, logger })` | `@octabits-io/mail/brevo` | `wretch` | Returns a real `messageId` → suitable for delivery/bounce tracking. |
| `createLoggerTransport({ logger })` | `@octabits-io/mail` | — | Logs instead of sending (dev). Synthesizes a dev Message-ID. |
| `createMemoryTransport()` | `@octabits-io/mail` | — | Captures messages in memory for tests, with inspection helpers. |

Each provider also ships a low-level client factory
(`createSmtpTransporter` / `createMailjetClient` / `createBrevoClient`) and a
connection verifier (`verifySmtpConnection` / `verifyMailjetConnection` /
`verifyBrevoConnection`).

## Example

```ts
import { createSmtpTransport } from '@octabits-io/mail/smtp';

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
