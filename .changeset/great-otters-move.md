---
"@octabits-io/framework": patch
---

Follow the workflow engine's rename: `@octabits-io/flow` is now `octaflow`.

Imports and the peer range move together (`^0.12.0` → `^0.15.0`). The old
package is deprecated on npm at 0.13.0 and would have kept the framework three
minors behind — including a step-claim race and a stall where a lost dispatch
stranded a workflow forever, both fixed since.

No API change here: `createFlowWorkflowRoutes` and everything around it are
untouched, and the engine's exports kept their names through the rename.
