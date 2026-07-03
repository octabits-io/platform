---
"@octabits-io/elysia": minor
---

Add `createRateLimit` plugin factory: a domain-agnostic wrapper around
`elysia-rate-limit` reproducing the standard API rate-limit config (fixed window
keyed on `derived.clientIp`, `{ key, message }` 429 JSON body) with a
parameterized skip seam — bypass by internal-secret header **or** trusted CIDR
prefix. Options: `max`, `windowMs`, `skipCidrs`, `internalSecret`,
`internalSecretHeader`, `keyByClientIp`, `errorKey`, `errorMessage`.
