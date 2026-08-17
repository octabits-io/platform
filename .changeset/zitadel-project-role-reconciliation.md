---
'@octabits-io/framework': minor
---

feat(zitadel): add `addProjectRole` + `listProjectGrants`, and fix the always-stale diff in `syncProjectGrant`

The Zitadel client could read a project's roles and propagate them to grants,
but could not **create** a role and could not read a grant's current
`roleKeys` — `getProjectGrantId` returns the id alone. That left role
reconciliation impossible to build on the client: a consumer wanting to assert
"every role in my registry exists on the project, and every tenant grant
delegates all of them" had to hand-roll both calls against `fetch`.

Two additions close that:

- **`addProjectRole({ projectId, projectOwnerOrgId, roleKey, displayName?, group? })`** —
  creates a role on the project. Zitadel rejects a duplicate key with
  `already_exists`, which a reconciling caller should read as "present".
- **`listProjectGrants({ projectId, projectOwnerOrgId })`** — every grant of a
  project with the role keys it currently delegates, as `ZitadelProjectGrant[]`
  (also newly exported).

`syncProjectGrant` had a latent bug the second addition fixes. It read the
existing grant's roles from the grant-search response as `roleKeys`, but that
response names the field **`grantedRoleKeys`** — `roleKeys` is the *write*-side
spelling. Every existing grant therefore compared as having zero roles, the
"unchanged" check never held, and every sync issued a PUT. It only looked
correct because Zitadel answers a no-op PUT with HTTP 400 `NoChangesFoundc`,
which the method already swallowed. The diff is now accurate: an up-to-date
grant is two reads and no write, and the `NoChangesFoundc` catch narrows to
what it was meant for — a stale read losing a race with a concurrent sync.

`getProjectGrantId` and `syncProjectGrant` both delegate their grant search to
`listProjectGrants`, so the field-name knowledge lives in one place.
