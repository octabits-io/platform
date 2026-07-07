---
"@octabits-io/captcha": minor
---

Security hardening from review:

- **Pluggable nonce store (ALTCHA)**: new `nonceStore?: CaptchaNonceStore` config seam with a single atomic `markRedeemed(nonce, ttlMs): boolean | Promise<boolean>` (maps directly onto Redis `SET NX PX`); the per-process LRU remains the default. Documented deployment caveats: the default store allows one replay per instance in multi-instance deployments, and more than `nonceCacheMaxSize` redemptions per expiry window can evict live nonces early (exposure capped by challenge expiry).
- **Nonce redemption order documented and locked in**: solution verification (awaited) happens first, then a synchronous atomic check-and-set — no await between check and set — with a regression test for concurrent double-redemption (exactly one of two parallel redeems succeeds).
- **Optional token binding**: `redeemChallenge`/`validateToken` accept `options?: { bind?: string }` (e.g. session id / user id / IP hash) mixed into the verified token's HMAC; a bound token only validates with the identical bind, an unbound token behaves exactly as before (wire-compatible). Verified tokens remain multi-use within their TTL by design.
- No-op provider accepts an optional `logger` and warns on construction ("captcha no-op provider active — all challenges auto-pass"; `console.warn` fallback) so an accidentally active no-op is visible in production logs.
- `createChallenge` failures now include the underlying error message in `challenge_creation_failed` (never the secret) instead of swallowing all detail.
- New test: near-miss token forgery (valid structure/expiry, wrong signature) exercises the constant-time compare path.
