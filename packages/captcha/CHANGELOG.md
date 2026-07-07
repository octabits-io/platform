# @octabits-io/captcha

## 0.3.0

### Minor Changes

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Security hardening from review:

  - **Pluggable nonce store (ALTCHA)**: new `nonceStore?: CaptchaNonceStore` config seam with a single atomic `markRedeemed(nonce, ttlMs): boolean | Promise<boolean>` (maps directly onto Redis `SET NX PX`); the per-process LRU remains the default. Documented deployment caveats: the default store allows one replay per instance in multi-instance deployments, and more than `nonceCacheMaxSize` redemptions per expiry window can evict live nonces early (exposure capped by challenge expiry).
  - **Nonce redemption order documented and locked in**: solution verification (awaited) happens first, then a synchronous atomic check-and-set — no await between check and set — with a regression test for concurrent double-redemption (exactly one of two parallel redeems succeeds).
  - **Optional token binding**: `redeemChallenge`/`validateToken` accept `options?: { bind?: string }` (e.g. session id / user id / IP hash) mixed into the verified token's HMAC; a bound token only validates with the identical bind, an unbound token behaves exactly as before (wire-compatible). Verified tokens remain multi-use within their TTL by design.
  - No-op provider accepts an optional `logger` and warns on construction ("captcha no-op provider active — all challenges auto-pass"; `console.warn` fallback) so an accidentally active no-op is visible in production logs.
  - `createChallenge` failures now include the underlying error message in `challenge_creation_failed` (never the secret) instead of swallowing all detail.
  - New test: near-miss token forgery (valid structure/expiry, wrong signature) exercises the constant-time compare path.

## 0.2.0

### Minor Changes

- [`75c2fac`](https://github.com/octabits-io/platform/commit/75c2fac0e6e8080d45ed03e22aa4639856cc5ce9) - New package `@octabits-io/captcha`: provider-agnostic captcha contract
  (challenge → redeem → verified-token → validate) with an ALTCHA proof-of-work
  implementation behind the `./altcha` subpath, a no-op transport for dev/test,
  and the `CAPTCHA_CONFIG_SCHEMA` config fragment. Extracted from reynt core
  (`services/infrastructure/captcha` + `schemas/captchaConfigSchema`).
  `altcha-lib` is an optional peer; `@octabits-io/foundation` (>=0.3.0) and `zod`
  (^4) are peers.
