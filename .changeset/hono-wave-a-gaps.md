---
'@octabits-io/framework': minor
---

Two `./hono` gaps surfaced by the first consumer wave (reynt customer-api):

- `createHonoApp` accepts a `hono` option (Hono constructor options for the
  composed serving app). Passing `{ strict: false }` restores Elysia's
  trailing-slash tolerance (`/x` ≡ `/x/`) for consumers migrating
  route-for-route — normalization happens on the outer app, so this could not
  be opted into from the routes side.
- `describeApiRoute` passes OpenAPI specification extensions (`x-…` keys, e.g.
  `'x-openai-isConsequential'`) through to the operation object.
