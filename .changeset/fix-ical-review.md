---
'@octabits-io/ical': patch
---

Review fixes for the initial (unreleased) release.

- Parser: pre-window occurrences no longer consume the RRULE occurrence cap — a recurring event with a DTSTART years in the past now yields its in-window occurrences instead of an empty result (a separate 500k skip guard still bounds runaway rules).
- Parser: the `windowEnd` expansion bound is read in UTC (`Time.fromJSDate(d, true)`), so window boundaries no longer shift with the server's TZ.
- Parser: RECURRENCE-ID overrides now surface the overriding VEVENT's own SUMMARY.
- Fetcher SSRF posture: scheme allowlist (http/https after the webcal rewrite; `ical_url_invalid` otherwise), rejection of literal private/loopback/link-local IP hostnames (`ical_url_private_network`, bypass via `allowPrivateNetwork: true`), and an injectable `fetch` for consumers that need DNS-rebinding/redirect protection via a safe dispatcher.
- Fetcher: the response cap is now enforced in bytes while streaming the body (aborting as soon as it is exceeded) instead of after buffering the full payload in UTF-16 units; `timeoutMs` and `maxResponseBytes` are configurable (defaults unchanged: 30 s / 5 MB).
- Fetcher: userinfo (`user:pass@`) is redacted from URLs in error messages and log metadata; DTSTAMP stripping handles RFC 5545 folded continuation lines.
- Docs: TZID-without-VTIMEZONE caveat on `parseEventRanges`; SSRF notes on the fetcher.
