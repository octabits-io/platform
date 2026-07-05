---
"@octabits-io/elysia": minor
---

Remove the deprecated tenant-named mcp aliases (breaking):

- `resolveScope` no longer receives the `tenantId` alias — destructure
  `scopeKey` instead (`resolveScope: async ({ scopeKey, context }) => ...`).
- `TENANT_ID_PATTERN` is gone — use `SCOPE_KEY_PATTERN`.
- The `invalidTenantResponse` option is gone — use `invalidScopeResponse`.

`parseTenantId` (the `/tenant/:tenantId/` path convention as the default
`parseScopeKey`) is unchanged — it is the documented tenant preset, not a
deprecated alias.
