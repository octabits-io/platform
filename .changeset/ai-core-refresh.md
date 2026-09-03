---
"@octabits-io/nuxt-ui-kit": patch
---

`./ai`: two fixes found by driving the review loop in a browser.

- `useAiWorkflowGuard` rehydrating an already-terminal run now attaches the
  poll function without polling (`poller.attach`), so `refresh()` re-reads
  the run on demand — an apply's `appliedAt` reaches the surface without a
  page reload. Before, `refresh()` was silently a no-op for a run that was
  finished when the page mounted.
- The workflow poller fires `onCompleted`/`onFailed`/`onCancelled` on the
  transition into a terminal status only. Re-reading a run that was already
  terminal no longer re-fires the callback (which surfaced as a duplicate
  "ready" toast after every apply).
