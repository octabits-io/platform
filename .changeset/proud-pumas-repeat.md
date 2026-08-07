---
'@octabits-io/nuxt-ui-kit': minor
---

**Breaking:** remove the Eden Treaty client factory. `createTreatyClientFactory` and its `TreatyClientFactoryOptions` type are gone from `./api`, along with the `@elysiajs/eden` and `elysia` optional peer dependencies.

`./api` keeps the two seams that were never Eden-specific — `resolveApiBaseUrl` and `createAccessTokenProvider` — so a consumer on Hono's `hc` only drops the factory. Build the client with `hc` (prefer the API package's pre-compiled `hcWithType`) and inject the bearer through `hc`'s own async `headers` thunk:

```ts
const getToken = createAccessTokenProvider(getUserManager)
const client = hcWithType(getBaseUrl(), {
  headers: async () => {
    const token = await getToken()
    return token ? { authorization: `Bearer ${token}` } : {}
  },
})
```

Eden's `parseDate` has no counterpart and needs none: `hc` returns exactly what `res.json()` produced, so `YYYY-MM-DD` fields stay plain strings — the behavior the old factory had to opt into with `parseDate: false`.

`createApiErrorMessenger` still unwraps `{ value }` error envelopes; that tolerance is kept and is simply inert for clients that don't box the body.
