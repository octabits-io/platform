---
"@octabits-io/framework": minor
---

`createRateLimit`: new `skipPaths` option — path prefixes exempt from the limiter. For self-limiting endpoints that live outside the plugin hook chain, e.g. a `.mount()`ed SSE stream whose requests never see the client-IP plugin and would otherwise all share one "unknown" bucket.
