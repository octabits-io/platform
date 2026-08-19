---
'@octabits-io/framework': minor
---

Expose `ensureQueue()` on `QueueDomain` and on `defineQueue().createEnqueuer()`.

The step already existed and is already memoized — `enqueue` and `startWorker`
call it on first use — but there was no way to run it *on its own*, which the
ordinary producer never needs and one producer cannot do without.

That producer enqueues through a connection it does not own: a job written
inside someone else's open transaction, so the job and the state change that
produced it commit together (pg-boss's `SendOptions.db`). Creating a queue is
DDL and must never ride that transaction — a rollback would undo it, and its
locks could outlive the send. Such a caller has to ensure the queue on the pool
first and only then send, and until now its only options were to send once
non-transactionally to trigger the ensure, or to re-implement
create-DLQ-then-create-queue-pointing-at-it in its own code, where it would
drift from the version here.

It returns `Promise<Result<void, QueueError>>` like the rest of the interface —
a failing ensure (dead pool, missing DDL permission) is a value, not a throw.
Concurrent first calls now share a single run instead of each issuing the DDL,
and a failed ensure is not cached, so the next call retries.
