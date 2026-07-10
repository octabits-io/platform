---
"@octabits-io/flow": patch
---

Fix workflows stranded in `running` forever when a parallel branch fails while another branch is still in flight.

`checkWorkflowFailure` correctly waited for in-flight steps to settle, but `onStepCompleted`'s terminal check only counted `completed`/`skipped` — a `failed` sibling made it wait too, so when the LAST in-flight step completed after an earlier parallel failure, neither path finalized the workflow. The completion path now routes through the failure check when any keyed sibling has failed, finalizing the workflow as `failed` (with dependent-skip cascade and compensation) once every remaining step settles. The map-child path already re-checked; this brings keyed DAG steps in line.
