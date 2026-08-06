---
"@octabits-io/framework": minor
---

zitadel: `inviteUserToOrg` accepts an optional `preferredLanguage`

Zitadel picks the language of the invitation mail from the user it creates.
Without a preference it falls back to the instance default, so an invite sent
on behalf of a German tenant arrived in English regardless of that tenant's
configured language.

The tag is applied only when the user does not already exist — an existing
user has their own preference and it must not be overwritten by whoever
happens to invite them next.
