---
'@octabits-io/framework': minor
---

**`./logger`: implement OTLP log export.** `LoggingConfig.otlp` has always been typed and validated (`LOGGING_CONFIG_SCHEMA.otlp`) with the promise that "logs will be sent to an OTLP collector" — but `createLoggerService` never read the field, so consumers forwarding it got nothing. It now works.

When `otlp` is set, records are batched and POSTed to the collector as OTLP/HTTP **JSON** via plain `fetch` — no OpenTelemetry SDK, so `./logger` stays dependency-free for the consumers that only log to stdout. No consumer change is needed: the existing `endpoint`/`headers` config starts taking effect on upgrade.

Delivery is best-effort by design — logging must not be able to fail a request. Export runs off the hot path, a full buffer drops its oldest records, and failures are reported through `onError` (default `console.error`) rather than thrown. Nothing is retried.

- New: `createOtlpLogExporter` and the `OtlpLogExporter` / `OtlpExporterConfig` / `LogRecord` types are exported from `@octabits-io/framework/logger`.
- `OtlpExporterConfig` adds optional `maxBatchSize` (512), `maxQueueSize` (2048), `scheduledDelayMs` (5000), `timeoutMs` (10000), `onError`, and a `fetchImpl` test seam alongside `endpoint`/`headers`.
- `LoggerService.shutdown()` is no longer a no-op: it drains the export buffer and awaits in-flight requests. **Consumers configuring `otlp` should `await loggerService.shutdown()` on exit**, or buffered records are lost. It remains a no-op without `otlp`.

Two behaviour changes fall out of unifying the development and production loggers so both feed the exporter:

- `consoleOutput: false` is now honoured in `environment: 'development'` too (previously it silenced production JSON output only, and dev logs printed regardless).
- Development output now prints an error's stack on its own line below the message. It was previously dropped entirely from the human-readable renderer; it has always been present in the JSON/exported record.
