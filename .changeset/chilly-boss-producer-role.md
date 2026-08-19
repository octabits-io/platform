---
'@octabits-io/framework': minor
---

queue: `createBossManager` takes a `role` so send-only processes stop running pg-boss's background machinery

`send()` needs a *started* boss — pg-boss owns its own pool and opens it in
`start()` — so a process that only enqueues still has to start one. Until now
that meant starting a *full* one: maintenance supervision, the queue monitor,
the cron timekeeper, and a schema migration pass. That is the right shape for a
long-lived consumer and the wrong one for a cron pod that enqueues three jobs
and exits ten seconds later.

`role: 'producer'` sets `supervise: false`, `schedule: false`, `migrate: false`
and nothing else. `role: 'full'` (the default) is byte-for-byte the previous
behavior, so existing consumers are unaffected.

`migrate: false` is the load-bearing flag. With migration on, every start is a
potential DDL run, and ephemeral producers race the long-lived processes over
the same schema on every tick. With it off, pg-boss *checks* the installation
instead and throws `pg-boss is not installed` or `pg-boss database requires
migrations` — which is what a producer wants: it never migrates, and it fails
loudly rather than proceeding against a schema it cannot use.

The consequence to know about: a `'producer'` process cannot bootstrap a fresh
database. Something with `role: 'full'` must have started at least once first —
and when that ordering is wrong, `start()` now says so in those terms rather
than reporting pg-boss's bare "pg-boss is not installed" (the original is kept
as the error's `cause`).

```ts
const bossManager = createBossManager({
  connectionString,
  logger,
  role: 'producer', // enqueues and exits; never consumes, never migrates
});
```
