---
"@octabits-io/nuxt-ui-kit": minor
---

Split the AI-UX layer into a framework-free core and Vue bindings.

`@octabits-io/nuxt-ui-kit/ai/core` is new: the workflow poller, the
cross-page progress store, the card state machine, the active-workflow probe,
the rehydrate-and-trigger guard, the pausable interval, and the typed workflow
registry — with no import from Vue, from the rest of the kit, or from any
vendor (lint-enforced). Each state machine is an observable (`get()` +
`subscribe()`) plus actions; derived values are pure functions. That is the
shape React's `useSyncExternalStore` consumes and the shape a Vue `shallowRef`
mirrors in three lines, so a second framework adapter is a thin file.

The existing composables on `./ai` keep their signatures and behaviour and are
now those thin files: `useAiWorkflow`, `useAiWorkflowGuard`,
`createAiProgressCore`, `useAiCardState`, `useActiveAiWorkflowProbe`. Two
small changes at the edges: the refs they return are read-only computeds
(nothing was writing to them), and each exposes its core object (`poller`,
`store`) for hosts that drive it from a push channel. `./ai` re-exports the
core, so nothing needs a new import path.
