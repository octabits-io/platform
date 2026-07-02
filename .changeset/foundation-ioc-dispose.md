---
"@octabits-io/foundation": minor
---

IoC: `dispose()` now runs all remaining disposables even when one throws (single error rethrown, multiple wrapped in `AggregateError`) — previously a throwing disposable skipped the rest and leaked resources. Disposables also receive a new `DisposeOptions` argument (`{ commit: boolean }`, default `{ commit: true }`) so scope teardown can signal commit vs rollback to transaction-holding services.
