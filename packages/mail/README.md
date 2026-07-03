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
```

`@octabits-io/foundation` (`Result`, `Logger`) is a runtime dependency.

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

| Factory | Package | Notes |
| --- | --- | --- |
| `createSmtpTransport({ smtp, logger })` | `nodemailer` | The only transport that honors `returnPath` via the SMTP envelope. |
| `createMailjetTransport({ mailjet, logger })` | `node-mailjet` | Send v3.1 API; `messageId` is always `null`. |
| `createBrevoTransport({ brevo, logger })` | `wretch` | Returns a real `messageId` → suitable for delivery/bounce tracking. |
| `createLoggerTransport({ logger })` | — | Logs instead of sending (dev). Synthesizes a dev Message-ID. |
| `createMemoryTransport()` | — | Captures messages in memory for tests, with inspection helpers. |

Each provider also ships a low-level client factory
(`createSmtpTransporter` / `createMailjetClient` / `createBrevoClient`) and a
connection verifier (`verifySmtpConnection` / `verifyMailjetConnection` /
`verifyBrevoConnection`).

## Example

```ts
import { createSmtpTransport } from '@octabits-io/mail';

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
