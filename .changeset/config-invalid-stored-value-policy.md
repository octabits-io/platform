---
"@octabits-io/drizzle-toolkit": minor
---

config: add `onInvalidStoredValue` policy to the scoped config engine. A present stored row that fails schema validation on read now either falls back to the schema default (`'use-default'`, the existing behavior and default) or is left absent (`'skip'`), letting consumers surface corrupt/legacy values instead of masking them behind the default. Genuinely-absent rows still default under both policies.
