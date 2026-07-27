---
"@octabits-io/framework": patch
---

elysia errors: map `*_invalid_status` keys to 409 (they previously fell through the generic conventions to a redacted 500 "Internal error" — hit in production by reynt's booking-draft `mark-confirmed`), and log 5xx `ApiError`s in `createErrorHandler` so redacted responses leave a server-side trace.
