---
"@octabits-io/framework": patch
---

queue: keep the queue-ensure step compatible with pg-boss 12.28's nullable queue options

pg-boss 12.28 widened `UpdateQueueOptions` so `deadLetter`, `retryDelayMax` and
`heartbeatSeconds` accept `null` — the "clear this setting" signal `updateQueue`
understands. `createQueue` still takes `Omit<Queue, 'name'>`, where those three
are non-nullable, so `ensureQueueSynced` passing one options object to both no
longer typechecked.

The nulls are now dropped on the create leg only: on a queue that does not exist
yet, "clear it" and "never set it" are the same thing, and the `updateQueue` call
right after applies the clear for real on an existing queue. No behavior change
for any options object without a `null` in it.
