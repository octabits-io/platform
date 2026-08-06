---
'@octabits-io/nuxt-ui-kit': patch
---

Locale field tabs now lead with the default content locale instead of following
the app's stored locale order. `useLocaleTabs` already activates the default
locale, so an app whose locale set is `['en', 'de']` with `de` as the default
rendered `[EN][DE]` with DE selected — a strip that claims a primary language
the field does not use, on every translatable field at once. The remaining
locales keep their source order.
