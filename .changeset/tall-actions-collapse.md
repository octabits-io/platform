---
"@octabits-io/nuxt-ui-kit": minor
---

New `PageActions` component: a declarative, width-aware page-header action cluster. One `PageActionsItem[]` describes every action; `visibility: 'always' | 'auto' | 'menu'` controls placement, and below a header-width threshold (measured by `PageHeader` via ResizeObserver, provided as `PAGE_HEADER_WIDTH`) all `auto` items, utility items, and the Help trigger collapse into the ⋯ menu with their labels intact. Exports `PageActionsItem`, `PAGE_HEADER_WIDTH`, `PAGE_ACTIONS_COLLAPSE_BELOW`.
