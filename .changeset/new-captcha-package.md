---
"@octabits-io/captcha": minor
---

New package `@octabits-io/captcha`: provider-agnostic captcha contract
(challenge → redeem → verified-token → validate) with an ALTCHA proof-of-work
implementation behind the `./altcha` subpath, a no-op transport for dev/test,
and the `CAPTCHA_CONFIG_SCHEMA` config fragment. Extracted from reynt core
(`services/infrastructure/captcha` + `schemas/captchaConfigSchema`).
`altcha-lib` is an optional peer; `@octabits-io/foundation` (>=0.3.0) and `zod`
(^4) are peers.
