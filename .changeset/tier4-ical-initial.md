---
"@octabits-io/ical": minor
---

Initial release: iCal ingestion primitives.

- `createICalFetcherService` — fetches iCal over http/webcal with plain `fetch` (30s timeout, 5 MB cap), strips `DTSTAMP` and hashes the content (cyrb53) for change detection.
- `parseEventRanges` — raw VEVENT occurrence ranges with RRULE expansion (capped at 5000 occurrences per event).
- `collapseToBlockedDateRanges` — optional layer collapsing occurrences into whole-day blocked date ranges (configurable hour threshold).
