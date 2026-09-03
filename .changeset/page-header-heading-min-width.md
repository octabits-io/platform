---
"@octabits-io/nuxt-ui-kit": minor
---

`PageHeader`: a `headingMinWidth` prop for compact record headers whose title
is content, not chrome.

The compact heading is `flex: 1 1 0%`, so its hypothetical width is zero and
the action cluster never wraps — the heading takes whatever the buttons leave.
In a 508px split pane with two labeled actions that was 148px, and a CMS
page's 78-character title rendered one word per line, 297px tall.
`headingMinWidth` (px) sets the heading's flex-basis instead, so once the
floor plus the cluster no longer fit, the cluster wraps under the heading and
the heading fills the first row. Unset keeps today's behaviour exactly.

The action cluster is also `justify-end` now, so when it wraps internally the
overflow row keeps the cluster's right edge.
