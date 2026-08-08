---
'@octabits-io/framework': patch
---

**Docs: document `createOtlpLogExporter`.** The 0.25.0 OTLP release exported the
exporter factory but `docs/foundation.md` only covered the `LoggingConfig.otlp`
path, so the standalone use — feeding records that don't come from this
package's `Logger`, or aiming a second exporter at a different collector — was
discoverable only from the changelog. The `./logger` section now shows
`createOtlpLogExporter` with `enqueue`/`forceFlush`/`shutdown`, and notes the
`fetchImpl` test seam.
