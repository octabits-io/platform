---
"@octabits-io/flow": minor
"@octabits-io/drizzle-toolkit": minor
---

Add `@octabits-io/flow` — durable DAG workflow engine (Zod-typed steps, Postgres store, pg-boss dispatcher, optional AI add-on with token/cost/quota instrumentation).

BREAKING (`@octabits-io/drizzle-toolkit`): the `./workflow` export has been removed; it is superseded by `@octabits-io/flow`. The unused `drizzle-orm` and `zod` peer dependencies were dropped along with it — the remaining `./db` module (error handling, pagination) is unchanged. `@octabits-io/foundation` moved from peerDependencies to dependencies (it is a plain utility library — consumers no longer need to install it themselves).
