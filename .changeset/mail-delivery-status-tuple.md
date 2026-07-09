---
"@octabits-io/mail": minor
---

Export `MAIL_DELIVERY_STATUSES`, a runtime tuple of the provider-agnostic delivery statuses (`['queued', 'sent', 'delivered', 'failed', 'bounced']`), from the root. `DeliveryStatus` is now derived from it (`(typeof MAIL_DELIVERY_STATUSES)[number]`), so the type and the runtime value are a single source of truth.

Previously `DeliveryStatus` was a type-only union, forcing a consumer that stores delivery status in a database enum to hand-maintain a parallel string list and re-verify it against every provider mapping (e.g. `mapBrevoEventToDeliveryStatus`). Consumers can now derive their storage enum directly from the package — e.g. `pgEnum('message_delivery_status', MAIL_DELIVERY_STATUSES)` — collapsing that translation-and-verification surface to a compile-time `satisfies` check.

Purely additive — the `DeliveryStatus` type is unchanged.
