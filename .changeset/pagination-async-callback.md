---
'@octabits-io/nuxt-ui-kit': patch
---

`usePagination`: accept an async `onPaginationChange`

The hook is a fire-and-forget refetch notification, and the loader passed to
it is almost always `async`. Typing it `() => void` made every such call site
a `@typescript-eslint/no-misused-promises` finding (18 in reynt's console) for
a shape that is correct by design. It now accepts `() => void | Promise<void>`
and the watcher `void`s the result explicitly.
