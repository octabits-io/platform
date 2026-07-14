---
"@octabits-io/nuxt-ui-kit": patch
---

Fix a type error in `SubSidebar.vue`'s mobile toggle. The inline `@click="open = true"` compiled to a handler returning `boolean`, which is not assignable to `UButton`'s `onClick` type (`(event) => void | Promise<void>` — a union, so TypeScript's "a value-returning function is assignable to a void-returning signature" rule does not apply). Any consumer running `vue-tsc` over the source-shipped SFC hit `TS2322`. The handler is now a named `openSidebar()` function.
