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

const fetcher = createICalFetcherService({
  logger,
  // all optional:
  fetch: myPinnedFetch,        // default globalThis.fetch
  timeoutMs: 30_000,           // default 30s
  maxResponseBytes: 5_242_880, // default 5 MB
  allowPrivateNetwork: false,  // default false
});

const result = await fetcher.fetch('webcal://example.com/cal.ics', previousHash);
if (!result.ok) {
  // result.error.key: 'ical_fetch_failed' | 'ical_fetch_timeout' | 'ical_too_large' | …
  return;
}
const { data, hash, hasChanged } = result.value;
```

- `webcal://` is rewritten to `https://`; after that only `http:`/`https:`
  schemes are accepted — everything else (e.g. `file:`) is rejected.
- URLs whose hostname is a **literal** private, loopback, or link-local IP
  (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`, `fc00::/7`,
  `fe80::/10`, IPv4-mapped forms) are rejected unless `allowPrivateNetwork:
  true` is set.
- **SSRF note:** the private-IP check only sees literal IPs. It cannot see
  what a DNS name resolves to (DNS rebinding), and redirects are followed for
  feed portability — a public URL may redirect to a private address. If you
  need DNS-rebinding or redirect-to-private protection, inject a `fetch`
  bound to a safe dispatcher (e.g. an undici Agent with a filtering
  `lookup`/`connect`).
- Configurable timeout (default 30 s) via `AbortController` — it covers both
  headers and body download.
- Response cap (default 5 MB) counted in **bytes**: rejected early from
  `Content-Length` when present, and enforced again while streaming the body —
  the download is aborted as soon as the cap is exceeded, never buffered in
  full.
- `DTSTAMP` lines (including RFC 5545 folded continuation lines) are stripped
  before hashing — calendar servers regenerate them on every export, so
  keeping them would make every fetch look like a change.
- Userinfo (`user:pass@`) is redacted from URLs before they appear in error
  messages or log metadata.
- The hash is a fast **non-cryptographic** cyrb53 digest, used only for change
  detection. Pass the previous hash to get `hasChanged`; pass `null`/omit to
  always report changed.

| Error key | When |
| --- | --- |
| `ical_url_invalid` | Unparsable URL, or a scheme other than http(s)/webcal. |
| `ical_url_private_network` | Literal private/loopback/link-local IP hostname (without `allowPrivateNetwork`). |
| `ical_fetch_failed` | Non-2xx response (carries `status`). |
| `ical_fetch_timeout` | Request exceeded the timeout (default 30 s). |
| `ical_too_large` | Response exceeded the byte cap (default 5 MB). |
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
recurring feeds. `windowStart` drops occurrences that already ended — those
pre-window occurrences do **not** count against the occurrence cap, so a
DTSTART years in the past still yields the current window (a separate internal
runaway guard bounds the skipping). `maxOccurrencesPerEvent` (default 5000)
overrides the safety cap.

**Timezone caveat:** ical.js bundles no IANA timezone data. `TZID` references
are only honoured when the feed ships a matching `VTIMEZONE`; otherwise the
timestamps are interpreted in the **server's own zone**. Absolute instants
(`start`/`end`) are therefore only reliable for UTC/floating times or feeds
that include their `VTIMEZONE`s — the `startWallClock`/`endWallClock`
components are always the event's own wall-clock reading and are safe
regardless.

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
