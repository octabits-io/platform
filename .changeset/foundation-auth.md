---
"@octabits-io/foundation": minor
---

Add the `@octabits-io/foundation/auth` subpath: generic OIDC/JWT validation.
`createJwtValidationService<TToken>({ issuerUrl, audience, logger, claimMapper,
authBypassSecret?, bypassToken? })` performs lazy OIDC discovery (with a 30s
discovery-failure cooldown), JWKS-backed signature verification via `jose`
(`createRemoteJWKSet` + `jwtVerify`, issuer/audience checked), and hands the verified
payload to an injected `claimMapper(payload) => ClaimMapperResult<TToken>` so all
provider-specific (e.g. Zitadel) claim knowledge stays in the consumer. Includes the
production-neutralized auth-bypass path (returns a caller-supplied `bypassToken`),
`extractBearerToken`, and `validateAuthorizationHeader`. Exports the `JwtValidationService`,
`JwtValidationServiceConfig`, `JwtValidationError`, `ValidateResult`, `ClaimMapper`, and
`ClaimMapperResult` types. Adds `jose ^6.2.3` as a runtime dependency.
