---
"@octabits-io/nuxt-ui-kit": patch
---

**PageActions: a collapsed AI row no longer renders under Delete.**

AI items bound to the overflow menu (explicit `visibility: 'menu'`, or `'auto'`
in a header too narrow to hold them) were appended after every menu section.
Destructive rows are the last-declared section by convention, so the AI group
always landed below them — a "Generate page content" row reading as an
afterthought to the deletion.

They now sit with the other collapsed actions, ahead of the menu-only sections.
The ordering rule moved out of the SFC into `buildMenuActionGroups` in
`pageActions.ts`, where it is pure and tested.
