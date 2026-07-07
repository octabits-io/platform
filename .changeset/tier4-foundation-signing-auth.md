---
"@octabits-io/foundation": minor
---

New `./signing` subpath and API-key auth primitives in `./auth`.

- `./signing`: `createScopedSigningService({ infoPrefix, scopeKey, keyStore })` — per-scope, per-purpose signing with HKDF domain separation (`${infoPrefix}-${purpose}-signing-key-v1`), `hmac`/`verifyHmac`, `shortTag`/`verifyShortTag`, and `signJwt`/`verifyJwt` (jose optional peer, loaded lazily). The scope is an opaque string; keys live behind an injected `keyStore` read/write pair.
- `./auth`: `createApiKeyFormat({ prefix })` — generate/parse/verify `<prefix><keyId>.<secret>` bearer tokens with SHA-256-at-rest secrets and constant-time verification; `createBearerAuthService({ strategies })` — ordered bearer-strategy dispatcher (`{ matches, validate }[]`) that routes API-key and JWT tokens through one entrypoint.
