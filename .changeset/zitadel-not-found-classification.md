---
"@octabits-io/framework": patch
---

fix(zitadel): classify "could not be found" and gRPC code 5 as `not_found`

`classifyZitadelError` only matched the bare "not found" wording, so Zitadel's
v2 query responses — "User could not be found" with gRPC status `NOT_FOUND`
(code 5) — fell through to `api_error`. Callers relying on the `not_found`
discriminator (e.g. `getUserById`) therefore misread a genuine miss as an
opaque failure. The matcher now also recognises the "could not be found"
phrasing and `"code":5`. Surfaced by a new integration test against a real
Zitadel instance.
