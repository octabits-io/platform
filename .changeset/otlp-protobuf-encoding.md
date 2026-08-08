---
'@octabits-io/framework': minor
---

**`./logger`: export OTLP as protobuf, not JSON.** The exporter POSTed
OTLP/JSON, which the spec makes optional — and real backends decline it.
VictoriaLogs answers such a request with `400 … json encoding isn't supported
for opentelemetry format`, so every exported record was silently dropped
against it. Records now go out as `application/x-protobuf`, the encoding the
spec requires every receiver to accept.

The encoder (`./otlp-protobuf`) is hand-written — varint, fixed64, and
length-delimited fields are all OTLP logs uses — because `./logger` is a base
module that every other module imports and must not pull in an SDK. It consumes
the same payload tree `encodeLogsPayload` already built for JSON, so grouping,
attribute mapping, and timestamps keep exactly one implementation.

`encoding: 'json'` restores the previous wire format for a collector known to
accept it, and `LOGGING_CONFIG_SCHEMA` parses it alongside `endpoint` and
`headers` so the switch is reachable from env config. Nothing else changes:
same config, same batching, same best-effort delivery.

Two related fixes to attribute encoding: integers beyond `Number.MAX_SAFE_INTEGER`
now go out as `doubleValue` instead of an `intValue` that overflows int64 — or,
from `1e21`, one the encoder could not parse at all, which cost the entire batch
rather than the one attribute. And `content-type` is no longer overridable
through `headers`, so a leftover `application/json` cannot mislabel a protobuf
body.

Worth knowing if you relied on the old default: a receiver that only parsed
JSON will now reject these requests, and `onError` will say so.
