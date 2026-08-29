---
"@octabits-io/nuxt-ui-kit": patch
---

useHelpPanel: a registration now belongs to the component that made it

Consumers key help registrations by *surface*, so several pages legitimately
share one tab value — an admin console where every flat page registers
`'detail'` is the motivating case. On a client-side navigation Vue runs the
incoming component's `setup()` before the outgoing one's `onUnmounted`, so the
calls arrive as register(new) → unregister(old). Removal was by key alone, so
the departing component deleted its successor's registration and the Help
trigger disappeared for the rest of the session — every arrival wiped by the
page it had just replaced.

Removal is now owner-checked, and `register` returns a disposer that removes
only its own registration (a stale disposer is a no-op). `unregister(tab)` is
unchanged for existing callers; registrations made outside a component have no
owner and are still removed unconditionally.
