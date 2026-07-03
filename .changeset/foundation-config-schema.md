---
"@octabits-io/foundation": minor
---

New subpath **`@octabits-io/foundation/config-schema`** — reusable Zod fragments for backend service-container config schemas, extracted from the triplicated sections that every container repeated verbatim:

- `nonEmptyString` / `nonEmptyUrl` — the two string primitives every config is built from.
- `DATABASE_CONFIG_SCHEMA` — connection URL + pool knobs (`poolMaxConnections`, idle/connection/statement timeouts). RLS is deliberately excluded (surface-specific defaults) and composed via `createRlsSchema(defaultEnabled)` + `.extend(...)`.
- `LOGGING_CONFIG_SCHEMA` — log level + optional OTLP export config.
- `CAPTCHA_CONFIG_SCHEMA` — ALTCHA proof-of-work config, self-contained with the "hmacSecret required when enabled" refinement.

App-specific sections (storage, auth/OIDC field sets, domain config) intentionally stay in each app.
