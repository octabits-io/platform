---
"@octabits-io/foundation": minor
---

New subpath **`@octabits-io/foundation/config-schema`** — reusable Zod fragments for backend service-container config schemas, extracted from the triplicated sections that every container repeated verbatim:

- `nonEmptyString` / `nonEmptyUrl` — the two string primitives every config is built from.
- `DATABASE_CONFIG_SCHEMA` — connection URL + pool knobs (`poolMaxConnections`, idle/connection/statement timeouts). RLS is deliberately excluded (surface-specific defaults) and composed via `createRlsSchema(defaultEnabled)` + `.extend(...)`.
- `LOGGING_CONFIG_SCHEMA` — log level + optional OTLP export config.

App-specific sections (storage, auth/OIDC field sets, captcha, domain config) intentionally stay in each app — captcha in particular is a product choice (ALTCHA), not foundation.
