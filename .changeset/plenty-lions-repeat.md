---
"@octabits-io/pii": minor
---

Remove the deprecated `TenantKey*` type aliases (breaking): `TenantKeys`,
`TenantKeyCache`, `TenantKeyDb`, `TenantKeyError`, `TenantKeyNotFoundError`,
and `TenantKeyGenerationError` are gone — use the `ScopedKey*` equivalents
(`ScopedKeys`, `ScopedKeyCache`, `ScopedKeyDb`, `ScopedKeyError`,
`ScopedKeyNotFoundError`, `ScopedKeyGenerationError`). The tenant preset
itself (`createTenantKeyService`, `TenantKeyService`, `TenantKeyServiceDeps`)
is unchanged.
