---
"@octabits-io/framework": minor
---

zitadel: user lifecycle calls and an instance-wide grant index

- `deactivateUser` / `reactivateUser` / `deleteUser` — the reversible lock and
  the irreversible delete, previously absent, so a consumer could revoke a
  user's grants but never touch the account itself.
- `listAllUserGrants()` — every grant on the instance in one pass over the
  orgs, the inverse index to the per-user `listUserGrants`. Costs `orgs`
  requests where asking per user costs `users × orgs`. Pages each org's search
  (the single-org helpers take Zitadel's default page size and stop there), and
  reports per-org failures in `failedOrgIds` instead of dropping them, so a
  caller acting on "this user holds no grant" can refuse when the real answer
  is "we could not ask".
- `ZitadelUser.type` — `human` | `machine` | `unknown`. Service accounts hold
  no project grants by nature, so without this they are indistinguishable from
  abandoned human accounts to any grant-based staleness test.
