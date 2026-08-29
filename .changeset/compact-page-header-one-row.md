---
"@octabits-io/nuxt-ui-kit": minor
---

`PageHeader` `density="compact"` is now genuinely compact, and the heading block is optional.

`compact` used to differ from `default` only in title size: it still spent `py-4` on a title with the subtitle stacked underneath, which on a split-pane view (`SubSidebar`'s `#header` slot sits outside the scroll container) is ~85px of chrome that never scrolls away.

- Subtitle renders **beside** the title rather than under it, and the padding is sized to the action buttons (`py-2.5`) instead of to two text lines. Title drops `text-lg` → `text-base`. ~85px → ~53px.
- The inline treatment applies only when `PageHeader` itself renders the heading. A `#title` slot carries its own layout, so slot users keep the wrapper they were laid out against.
- The heading block is skipped entirely when there is no `title`, `subtitle`, `#title` slot or `loading` — a compact band may legitimately carry actions alone, where the page name is already in the breadcrumb above it.

`SubSidebar` now renders a visually-hidden `<h1>` with its `title`, so a split view keeps a heading when its header slot no longer repeats the page name and nothing is selected in the detail column.
