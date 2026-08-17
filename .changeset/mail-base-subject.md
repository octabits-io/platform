---
'@octabits-io/framework': minor
---

mail: expose `baseSubject` on rendered emails

`render()` and `buildEmailContent()` now return `baseSubject` alongside
`subject` — the template's own subject, before the `"<brand> - "` prefix and
the `"[→ …] "` redirect prefix are applied.

Consumers that persist a rendered subject as a durable **thread title** (rather
than as an envelope header) should switch to `baseSubject`. Storing the branded
`subject` and later re-sending under it brands an already-branded string,
producing `"Brand - Brand - …"`, and leaks the dev-only redirect prefix into
stored data.

`RenderedEmail.baseSubject` is optional so snapshots persisted before this
release deserialize unchanged; `dispatchRendered()` ignores it and continues to
send `subject` verbatim.
