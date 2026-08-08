---
'@octabits-io/framework': patch
---

Widen the `@hono/standard-validator` peer range to `^0.3.0 || ^0.4.0`.

The range was left at `^0.3.0` when the devDependency moved to `^0.4.0`, so
the declared peer excluded the only version this package is actually built and
tested against (and the current `latest`). A consumer following the peer range
would install 0.3.x.

The peer itself is load-bearing despite nothing in `src/` importing it:
`hono-openapi` statically imports `sValidator` from `@hono/standard-validator`
at the top of its entry module, so anything that pulls in
`@octabits-io/framework/hono/openapi` needs it resolvable at runtime. It stays
optional, since only that subpath requires it.
