# `@octabits-io/framework/zitadel`

Typed client for the [Zitadel](https://zitadel.com) **Management API** (not
OIDC — token *validation* lives in `./auth`): search users, orgs, and project
grants; create/delete organizations; invite users; keep project grants in
sync; update user profiles. Authenticates with a service-account Personal
Access Token (PAT). `wretch` is the module's optional peer (shared with
`./mail/brevo`).

Every public method returns `Promise<Result<T, ZitadelApiError>>` with a
classified error taxonomy — `not_found` / `already_exists` / `missing_field` /
`api_error` — so callers discriminate recoverable states without parsing
exception wording. The wording detection lives in `classifyZitadelError`
(exported; the `already_exists` match is load-bearing for reclaim-on-conflict
flows, since Zitadel phrases uniqueness conflicts several different ways
across endpoints).

## Usage

```ts
import { createZitadelManagementClient } from "@octabits-io/framework/zitadel";

const zitadel = createZitadelManagementClient({
  issuerUrl: "https://auth.example.com",
  pat: process.env.ZITADEL_PAT!,
  // Roles that must never be delegated to granted orgs via project grants:
  platformOnlyRoles: ["superadmin"],
  // Optional structured logger (warn-level, used on best-effort aggregation paths):
  logger,
});

const orgs = await zitadel.listOrganizations({ name: "ACME" });
if (!orgs.ok) throw new Error(orgs.error.message);

const invited = await zitadel.inviteUserToOrg({
  orgId: grantedOrgId,
  projectId,
  projectOwnerOrgId, // omit for same-org (platform-admin) invites
  email: "person@example.com",
  role: "admin",
});
```

## The org topology it models

Zitadel's multi-org SaaS shape: one **project-owning org** (the "platform"
org) owns a shared project and hosts every user account. Each customer org
receives a **project grant** delegating that project, and users get **user
grants** referencing it:

- `syncProjectGrant` upserts a grant so its `roleKeys` always equals
  *(all project roles − `platformOnlyRoles`)* — adding a new role to the
  project auto-propagates to existing granted orgs on their next write. (An
  empty `roleKeys` on a Zitadel project grant means "no roles available", not
  "all roles".)
- `inviteUserToOrg` searches-or-creates the user in the owning org, syncs the
  project grant for cross-org invites, and writes the user grant with the
  **granted** org as the `x-zitadel-orgid` context (Zitadel matches the
  grant's ResourceOwner against `projectGrant.grantedOrgId`).
- `listMembersByProjectGrant` / `findUserGrant` enumerate and check membership
  via the project grant — users hosted in the owning org are not enumerable
  from the granted org itself. Grant searches return raw
  `ZitadelUserGrantEntry` shapes; map them to your own member/domain types
  app-side.
- `listUserGrants` aggregates a user's grants across every org the PAT can
  see (per-org failures are logged and skipped).

Single-org deployments simply omit `projectOwnerOrgId` where it is optional.

## API surface

| Area | Methods |
|---|---|
| Users | `listAllUsers`, `getUserById`, `updateHumanUserProfile` |
| Orgs | `listOrganizations`, `createOrganization`, `deleteOrganization` |
| Project grants | `listProjectRoles`, `syncProjectGrant`, `getProjectGrantId` |
| User grants | `listOrgMembers`, `listMembersByProjectGrant`, `findUserGrant`, `listUserGrants`, `inviteUserToOrg`, `updateUserGrant`, `removeUserGrant`, `removeOrgMemberByUserId` |
| Errors | `classifyZitadelError`, `ZitadelApiError`, `ZitadelApiErrorKey` |
