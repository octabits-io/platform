---
'@octabits-io/nuxt-ui-kit': patch
---

Fix `createApiErrorMessenger`'s validation lookups being undefinable: field paths and message texts are now slugged (lowercased, non-alphanumeric runs collapsed to `_`) before the `validation.fields.<slug>` / `validation.messages.<slug>` lookups, so dotted paths (`items.0.email` → `items_0_email`) and punctuated messages (`Expected string to match 'email'` → `expected_string_to_match_email`) resolve to flat, definable vue-i18n keys instead of always falling through to raw values.
