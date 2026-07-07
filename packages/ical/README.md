# @octabits-io/ical

iCal ingestion in two independent pieces: a **fetcher** that pulls a calendar
over http(s)/`webcal` with a timeout, a size cap, and a change-detection hash;
and a **parser** that expands VEVENTs/RRULEs into raw event ranges, with an
optional day-blocking collapse layer on top. Both are domain-free — no booking
or rental vocabulary in the base API.

## Install

```bash
pnpm add @octabits-io/ical
```

`@octabits-io/foundation` (`Result`, `OctError`, `Logger`) and `ical.js` (v2)
are peer dependencies. Errors are foundation `Result`/`OctError` values (never
thrown); every error `key` is `ical_*`.

## Fetcher

```ts
import { createICalFetcherService } from '@octabits-io/ical';

const fetcher = createICalFetcherService({ logger });

const result = await fetcher.fetch('webcal://example.com/cal.ics', previousHash);
if (!result.ok) {
  // result.error.key: 'ical_fetch_failed' | 'ical_fetch_timeout' | 'ical_too_large' | …
  return;
}
const { data, hash, hasChanged } = result.value;
```

- `webcal://` is rewritten to `https://`.
- 30-second timeout via `AbortController`; a 5 MB response cap (checked against
  `Content-Length` and again against the actual body).
- `DTSTAMP` lines are stripped before hashing — calendar servers regenerate them
  on every export, so keeping them would make every fetch look like a change.
- The hash is a fast **non-cryptographic** cyrb53 digest, used only for change
  detection. Pass the previous hash to get `hasChanged`; pass `null`/omit to
  always report changed.

| Error key | When |
| --- | --- |
| `ical_fetch_failed` | Non-2xx response (carries `status`). |
| `ical_fetch_timeout` | Request exceeded the 30-second timeout. |
| `ical_too_large` | Response exceeded 5 MB. |
| _(passthrough)_ | Network/other failures map through `toOctError`. |

## Parser

### Base API — raw event ranges

`parseEventRanges` returns each VEVENT occurrence as-is: inclusive `start`,
**exclusive** `end` (per iCal DTEND semantics), `summary`, `uid`, and an
`allDay` flag. RRULEs are expanded, capped at 5000 occurrences per event to
guard against pathological rules (e.g. `FREQ=SECONDLY`).

```ts
import { createICalParserService } from '@octabits-io/ical';

const parser = createICalParserService();

const ranges = parser.parseEventRanges(icalData, {
  windowStart: new Date('2025-03-01'),
  windowEnd: new Date('2025-03-31'), // bounds RRULE expansion
});
if (!ranges.ok) return;
for (const r of ranges.value) {
  // { start: Date, end: Date, summary: string, uid: string, allDay: boolean }
}
```

`windowEnd` bounds recurrence expansion and is strongly recommended for
recurring feeds. `windowStart` drops occurrences that already ended.
`maxOccurrencesPerEvent` (default 5000) overrides the safety cap.

### Optional layer — day-blocking collapse

`collapseToBlockedDateRanges` is the opinionated layer on top: it collapses
events into blocked **calendar-day** ranges (`YYYY-MM-DD`, both ends inclusive)
within a window. All-day events map to their date span (exclusive DTEND, so the
last day is dropped); timed events are collapsed to whole days via an
`hourThreshold` heuristic (default `12`) — a timed event starting before the
threshold also blocks the previous day, and one ending before it stops on the
previous day. Non-overlapping ranges are filtered out.

```ts
const blocked = parser.collapseToBlockedDateRanges(
  icalData,
  new Date('2025-03-01'),
  new Date('2025-03-31'),
  { hourThreshold: 12 }, // optional
);
if (!blocked.ok) return;
// blocked.value: [{ start: '2025-03-09', end: '2025-03-10', summary: '…' }, …]
```

The heuristic mirrors check-in/check-out style day blocking. Consumers that want
raw ranges (or a different collapse) build on `parseEventRanges` instead.

## License

MIT
