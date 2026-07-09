---
'@octabits-io/foundation': minor
---

Absorb the `@octabits-io/vault` and `@octabits-io/captcha` micro-packages as foundation subpaths, and remove them as standalone packages.

Both had a single real consumer (reynt) and only a few hundred LOC each, so a dedicated package, release cadence, and peer-dependency edge cost more than they returned. Folding them in shrinks the platform graph from 11 packages to 9 and removes two nodes from the changesets peer/version cascade.

New subpath exports on `@octabits-io/foundation`:

- `@octabits-io/foundation/vault` — the boot-time HashiCorp Vault KV-v2 secret loader (was `@octabits-io/vault`). No new dependencies; still plain `fetch`, `zod` peer only.
- `@octabits-io/foundation/captcha` — the vendor-free captcha contract, error taxonomy, no-op transport, and ALTCHA config schema (was `@octabits-io/captcha`).
- `@octabits-io/foundation/captcha/altcha` — the ALTCHA implementation. `altcha-lib` is now an **optional** peer of foundation (same pattern as the `jose` peer for `./auth`), so consumers that don't use ALTCHA never load it.

**Migration for consumers of the old packages** (only reynt today):

- `@octabits-io/vault` → `@octabits-io/foundation/vault`
- `@octabits-io/captcha` → `@octabits-io/foundation/captcha`
- `@octabits-io/captcha/altcha` → `@octabits-io/foundation/captcha/altcha`

Drop `@octabits-io/vault` / `@octabits-io/captcha` from `dependencies` (foundation is already present). The already-published `@octabits-io/vault@0.3.0` and `@octabits-io/captcha@0.3.0` remain on npm, so existing installs keep working until they repoint. After this release, run `npm deprecate @octabits-io/vault "moved to @octabits-io/foundation/vault"` and `npm deprecate @octabits-io/captcha "moved to @octabits-io/foundation/captcha"`.
