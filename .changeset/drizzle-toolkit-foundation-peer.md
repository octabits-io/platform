---
"@octabits-io/drizzle-toolkit": patch
---

Declare `@octabits-io/foundation` as a peer dependency instead of a hard dependency, matching every other `@octabits-io/*` package. Because foundation's `Result`/`OctError`/`Logger` types appear in drizzle-toolkit's public API, a hard dep could resolve a second foundation instance when the two were bumped out of lockstep, producing TS2883 duplicate-identity errors on those shared types. As a peer (`>=0.2.0 <1`), the consumer's single foundation install is always the one used. Consumers already depending on foundation directly (as required by every other package) need no change.
