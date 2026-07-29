---
'@octabits-io/framework': minor
---

events: make `EventPublisher`/`createEventPublisher` generic over a consumer `EventDataMap` (event type → payload shape), so `emit` correlates `type` with its `data` at compile time, and add an optional `payloadSchemas` registry to `createEventPublisherDeps` that enforces the same contract at runtime (authoritative: unregistered types throw, invalid payloads throw, validation never strips). Unparameterized publishers behave exactly as before.
