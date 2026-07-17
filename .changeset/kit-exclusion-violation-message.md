---
"@octabits-io/nuxt-ui-kit": minor
---

i18n fragments gain `errors.exclusion_violation`

Matches the framework's new `exclusion_violation` database error code (SQLSTATE
23P01, e.g. overlapping range EXCLUDE constraints). `KitMessages` has a new
required key, so hand-built message objects need the entry; consumers merging
the shipped fragments are unaffected.
