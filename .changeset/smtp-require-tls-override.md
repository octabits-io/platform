---
"@octabits-io/framework": minor
---

feat(mail): add `requireTLS` override to the SMTP transport config

`SmtpTransportConfig` now accepts an optional `requireTLS?: boolean`. It still
defaults to `!secure` (STARTTLS required when implicit TLS is off, never
downgrading to plaintext), but can be set to `false` to reach a plaintext
dev/test SMTP server (Mailpit, Mailhog) that offers no TLS. Threaded through
both `createSmtpTransport`/`createSmtpTransporter` and `verifySmtpConnection`.
