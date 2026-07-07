# @octabits-io/ical

## 0.2.0

### Minor Changes

- [`ed7813e`](https://github.com/octabits-io/platform/commit/ed7813e8274c1246ab694703d59ced0839b2e5d3) - Initial release: iCal ingestion primitives.

  - `createICalFetcherService` — fetches iCal over http/webcal with plain `fetch` (30s timeout, 5 MB cap), strips `DTSTAMP` and hashes the content (cyrb53) for change detection.
  - `parseEventRanges` — raw VEVENT occurrence ranges with RRULE expansion (capped at 5000 occurrences per event).
  - `collapseToBlockedDateRanges` — optional layer collapsing occurrences into whole-day blocked date ranges (configurable hour threshold).

### Patch Changes

- [`513571d`](https://github.com/octabits-io/platform/commit/513571d069bac7ebd52234fcaf154aa8b1e8e315) - Review fixes for the initial (unreleased) release.

  - Parser: pre-window occurrences no longer consume the RRULE occurrence cap — a recurring event with a DTSTART years in the past now yields its in-window occurrences instead of an empty result (a separate 500k skip guard still bounds runaway rules).
  - Parser: the `windowEnd` expansion bound is read in UTC (`Time.fromJSDate(d, true)`), so window boundaries no longer shift with the server's TZ.
  - Parser: RECURRENCE-ID overrides now surface the overriding VEVENT's own SUMMARY.
  - Fetcher SSRF posture: scheme allowlist (http/https after the webcal rewrite; `ical_url_invalid` otherwise), rejection of literal private/loopback/link-local IP hostnames (`ical_url_private_network`, bypass via `allowPrivateNetwork: true`), and an injectable `fetch` for consumers that need DNS-rebinding/redirect protection via a safe dispatcher.
  - Fetcher: the response cap is now enforced in bytes while streaming the body (aborting as soon as it is exceeded) instead of after buffering the full payload in UTF-16 units; `timeoutMs` and `maxResponseBytes` are configurable (defaults unchanged: 30 s / 5 MB).
  - Fetcher: userinfo (`user:pass@`) is redacted from URLs in error messages and log metadata; DTSTAMP stripping handles RFC 5545 folded continuation lines.
  - Docs: TZID-without-VTIMEZONE caveat on `parseEventRanges`; SSRF notes on the fetcher.
