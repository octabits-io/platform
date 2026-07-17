---
'@octabits-io/nuxt-ui-kit': minor
---

`createAiProgressCore` accepts an optional `onTerminal(tracked)` callback, fired once per tracked workflow when polling observes its transition to a terminal status — alongside the existing `completionSignal` bump, but identifying which workflow finished. Enables per-workflow notifications (completion toasts, badges) in consumers.
