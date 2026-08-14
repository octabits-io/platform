---
'@octabits-io/framework': patch
---

Widen the `octaflow` optional peer range to `>=0.15.0 <1`.

`./hono/flow` declared `octaflow: ^0.15.0`, and a caret on a pre-1.0 version locks
the minor — so flow 0.16.0 fell out of range and consumers hit an unmet peer for a
release that changes nothing this module touches. The route factory reads flow's
public wire view (list/active/get/snapshot/cancel/resume); 0.16.0's breaking change
is confined to `StartJobProcessor` implementations, which live app-side.

The range now spans the whole pre-1.0 line, so flow's minors no longer need a
matching framework release to stay installable.
