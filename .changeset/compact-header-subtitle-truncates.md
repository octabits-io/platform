---
"@octabits-io/nuxt-ui-kit": patch
---

`PageHeader` `density="compact"`: a long inline subtitle now truncates instead of pushing the action cluster onto a second row.

The wrapper is `flex-wrap`, so a subtitle without `min-w-0` + `truncate` kept its min-content width, won the line, and wrapped the actions below it — a "compact" band that came out taller (101px) than the stacked two-line version it replaced (85px). `compact` promises one row; a subtitle long enough to truncate belongs in a help panel, not in chrome.

`SubSidebar`'s visually-hidden `<h1>` now renders only when `headerless`. Without it the rail draws its own visible heading, so a second invisible one for the same shell is noise — a nested settings layout announced "Settings" twice before the page's own name.
