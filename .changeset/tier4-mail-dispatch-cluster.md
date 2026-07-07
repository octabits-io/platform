---
"@octabits-io/mail": minor
---

Transactional dispatch layer, inbound-mail contract, and email-ingress guardrails.

- `createBaseMailService({ templates, configReader, transportFactory, ... })` — generic dispatch pipeline (template render → scoped config → recipient/delivery-mode resolution → transport selection with platform fallback → `onSend` hook), plus dev-override recipient redirection with subject prefixing. Template registry, classification, config lookup, and vendor transports are all injected seams; the root export stays vendor-free.
- `buildReplyAddress`/`parseReplyAddress` — tagged `reply+<scopeKey>.<resourceId>.<tag>@domain` / `bounce+…` address handling.
- Root contract types for inbound mail (`NormalizedInboundMessage`) and delivery events (`DeliveryStatus`, `NormalizedDeliveryEvent`); `./brevo` adds `parseBrevoInbound` and `parseBrevoEvents` + `mapBrevoEventToDeliveryStatus` normalizers (zod is a new optional peer, used only by `./brevo`).
- `screenInboundAttachment`/`fileExtension` — inbound-attachment security policy (size/count ceilings, executable/macro extension + MIME blocklists), configurable with safe defaults.
