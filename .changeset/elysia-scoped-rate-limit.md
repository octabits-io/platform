---
"@octabits-io/elysia": minor
---

`createRateLimit` accepts a `scoping` option (`'global'` | `'scoped'`), passed through to elysia-rate-limit. Use `scoping: 'scoped'` to mount a per-route limiter inside a route group — it guards only that group with its own counter, stacking with (and typically tighter than) the app-wide limit from the app skeleton, while keeping the standard client-IP keying and `{ key, message }` 429 body.
