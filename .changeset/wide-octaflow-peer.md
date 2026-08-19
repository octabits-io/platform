---
'@octabits-io/framework': patch
---

Widen the optional `octaflow` peer to `^0.16.0 || ^0.17.0`.

`./hono/flow` only consumes the public-view half of octaflow — `toPublicWorkflow`
/ `toPublicStep`, the response schemas, and the structural `FlowEngineReader` it
declares itself — none of which 0.17 touched. Its breaking changes are on the
worker seam (`handleStepJob` replacing `executeStep`) and the `WorkflowStore`
contract, neither of which the framework implements or calls.

The narrow range was load-bearing for consumers, not cosmetic: octaflow is an
*optional peer*, so a version outside the range forks the framework into a
second peer variant — two physical copies, two nominal identities for `Result`,
and a declaration emit that dies on TS2883.
