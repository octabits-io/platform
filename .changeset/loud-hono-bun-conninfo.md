---
'@octabits-io/framework': minor
---

hono: warn when `getConnInfo` fails on Bun instead of silently disabling per-IP rate limiting

`createClientIpMiddleware`'s default direct-IP seam caught every `getConnInfo`
error and returned `undefined`, which the resolver renders as the literal
string `'unknown'`. That is correct off-Bun (a Node test run has no conninfo),
but on Bun it is a silent security downgrade: if the Bun server object never
reaches `c.env`, *every* request resolves to `'unknown'` and each per-IP rate
limiter keyed on `clientIp` collapses into ONE global bucket shared by all
callers. The limiter keeps returning 429s, so it looks healthy while metering
the entire internet together.

The two cases are now distinguished. A failed `import('hono/bun')` means "not
on Bun" and stays silent; an import that succeeds while `getConnInfo` throws
means "on Bun and misconfigured" and warns once per process, naming the fix:

```ts
Bun.serve({ fetch: (request, server) => app.fetch(request, { server }) })
```

The key must be `server` — `hono/bun`'s `getBunServer` reads
`'server' in c.env ? c.env.server : c.env`, so any other property name falls
through to the env object itself, which has no `requestIP`.

`createClientIpMiddleware` accepts an optional `logger` for the warning
(defaults to `console.warn`). Behavior is otherwise unchanged and still fails
safe — requests succeed, the IP is simply unknowable.
