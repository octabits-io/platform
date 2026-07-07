---
"@octabits-io/elysia": minor
---

BREAKING (`./mcp`): `parseTenantId` removed in favor of `createPathSegmentScopeParser(segment)`, and `parseScopeKey` is now **required** — there is no default URL convention anymore, so the removal surfaces at compile time instead of as silent request rejection. Consumers that used the old default pass `parseScopeKey: createPathSegmentScopeParser('tenant')` to keep the `/tenant/:id/` layout; single-scope deployments pass `() => 'default'`.
