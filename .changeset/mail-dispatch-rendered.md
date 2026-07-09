---
"@octabits-io/mail": minor
---

Add `dispatchRendered(params, rendered)` to `createBaseMailService`, splitting rendering from delivery. `render(params)` already produced a `RenderedEmail` without sending; `dispatchRendered` now delivers one verbatim — the content and recipients are sent as-is while transport/From/fallback routing is recomputed via a fresh `configReader(params)` read (the template is never rebuilt), and the header-injection guard runs again before any transport contact.

This lets a consumer render now and deliver later: retry a rendered message, defer a send, or build a hold-for-review flow the consumer owns end-to-end (render → park in its own outbox → re-dispatch after approval), without re-implementing the pipeline's routing/delivery half. Purely additive — existing `send()`/`render()` behavior is unchanged.
