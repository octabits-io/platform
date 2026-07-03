---
"@octabits-io/foundation": minor
---

Add the `@octabits-io/foundation/rbac` subpath: a small, dependency-free RBAC engine.
Exports `createRole(permissions)` → `{ permissions, authorize(requested) }` (pure
resource/action subset check) and `checkLocalPermission(roles, roleName, permissions)`
against a caller-supplied role registry. Generic over a caller-supplied permission
`Statement` type — the concrete statement matrix, named roles, and derived
permission-request types stay in the consuming application. Also exports the
`Statement`, `RolePermissions`, `Role`, and `AuthorizeResult` types.
