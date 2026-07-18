---
"@octabits-io/framework": minor
---

Add `./zitadel` — typed client for the Zitadel Management API (users, orgs, project grants, roles, invites) with the `not_found` / `already_exists` / `missing_field` / `api_error` error taxonomy and `Result`-based returns. App-tier module; `wretch` (already an optional peer) is its vendor SDK. Generalized from its origin: `platformOnlyRoles` is injected config, grant searches return raw `ZitadelUserGrantEntry` shapes (domain mapping stays app-side), and the per-scope lookup ships de-tenanted as `findUserGrant`.
