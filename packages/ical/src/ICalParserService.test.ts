import { test, expect } from 'vitest'
import { createICalParserService } from './ICalParserService.ts';

const icalParserService = createICalParserService();

const eventFullDay = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916305416-87127@ical.marudot.com
DTSTART;VALUE=DATE:20250309
DTEND;VALUE=DATE:20250311
SUMMARY:Date 9.3.2025 and 10.3.2025
END:VEVENT
END:VCALENDAR`;

test('eventFullDay', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventFullDay, new Date('2025-03-01'), new Date('2025-03-31'));

  expect(x).toEqual({
    ok: true,
    value: [{
             "end": "2025-03-10",
             "start": "2025-03-09",
              "summary": "Date 9.3.2025 and 10.3.2025"
           }]
  })
});

// The base API returns the raw VEVENT occurrence: exclusive DTEND, all-day flag,
// no day collapsing.
test('parseEventRanges returns raw all-day occurrence with exclusive end', () => {
  const x = icalParserService.parseEventRanges(eventFullDay, {
    windowStart: new Date('2025-03-01'),
    windowEnd: new Date('2025-03-31'),
  });

  expect(x.ok).toBe(true);
  if (!x.ok) return;
  expect(x.value).toHaveLength(1);
  const [range] = x.value;
  expect(range?.allDay).toBe(true);
  expect(range?.summary).toBe('Date 9.3.2025 and 10.3.2025');
  expect(range?.uid).toBe('1742916305416-87127@ical.marudot.com');
  // DTEND is exclusive: 2025-03-11 (00:00), start 2025-03-09.
  expect(range?.start.getFullYear()).toBe(2025);
  expect(range?.start.getMonth()).toBe(2); // March (0-based)
  expect(range?.start.getDate()).toBe(9);
});

// The base API expands RRULEs into one raw occurrence per instance.
test('parseEventRanges expands RRULE occurrences', () => {
  const recurring = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916510346-22850@ical.marudot.com
DTSTART;VALUE=DATE:20250303
RRULE:FREQ=WEEKLY;BYDAY=MO
DTEND;VALUE=DATE:20250304
SUMMARY:Repeats every monday
END:VEVENT
END:VCALENDAR`;

  const x = icalParserService.parseEventRanges(recurring, {
    windowEnd: new Date('2025-03-30'),
  });

  expect(x.ok).toBe(true);
  if (!x.ok) return;
  // Mondays: Mar 3, 10, 17, 24 within the window.
  expect(x.value).toHaveLength(4);
  expect(x.value.every((r) => r.summary === 'Repeats every monday')).toBe(true);
});

const eventFrom16to19 = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916341773-95418@ical.marudot.com
DTSTART;TZID=Europe/Berlin:20250316T160000
DTEND;TZID=Europe/Berlin:20250316T190000
SUMMARY:Event from 16:00 to 19:00
END:VEVENT
END:VCALENDAR`;

test('eventFrom16to19', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventFrom16to19, new Date('2025-03-01'), new Date('2025-03-31'));

  expect(x).toEqual({
    ok: true,
    value: [{
              "end": "2025-03-16",
              "start": "2025-03-16",
              "summary": "Event from 16:00 to 19:00"
    }]
  })
});


const eventRepeatingFullDay = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916510346-22850@ical.marudot.com
DTSTART;VALUE=DATE:20250303
RRULE:FREQ=WEEKLY;BYDAY=MO
DTEND;VALUE=DATE:20250304
SUMMARY:Repeats every march 3rd
END:VEVENT
END:VCALENDAR`;


test('eventRepeatingFullDay', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventRepeatingFullDay, new Date('2025-03-01'), new Date('2025-03-30'));

  expect(x).toEqual({
    ok: true,
    value: [{
      "end": "2025-03-03",
      "start": "2025-03-03",
      "summary": "Repeats every march 3rd"
    }, {
      "end": "2025-03-10",
      "start": "2025-03-10",
      "summary": "Repeats every march 3rd"
    }, {
      "end": "2025-03-17",
      "start": "2025-03-17",
      "summary": "Repeats every march 3rd"
    }, {
      "end": "2025-03-24",
      "start": "2025-03-24",
      "summary": "Repeats every march 3rd"
    }]
  })
});


const eventFrom08to20 = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916379463-35406@ical.marudot.com
DTSTART;TZID=Europe/Berlin:20250319T080000
DTEND;TZID=Europe/Berlin:20250319T200000
SUMMARY:Event from 8:00 to 20:00
END:VEVENT
END:VCALENDAR
`

test('eventFrom08to20', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventFrom08to20, new Date('2025-03-01'), new Date('2025-03-31'));

  expect(x).toEqual({
    ok: true,
    value: [{
      "end": "2025-03-19",
      "start": "2025-03-18",
      "summary": "Event from 8:00 to 20:00"
    }]
  })
})

const eventFrom20to08 = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916416029-58682@ical.marudot.com
DTSTART;TZID=Europe/Berlin:20250323T200000
DTEND;TZID=Europe/Berlin:20250324T080000
SUMMARY:Event from 20:00 to 8:00
END:VEVENT
END:VCALENDAR
`

test('eventFrom20to08', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventFrom20to08, new Date('2025-03-01'), new Date('2025-03-31'));

  expect(x).toEqual({
    ok: true,
    // value: ['2025-03-23']
    value: [{
      "end": "2025-03-23",
      "start": "2025-03-23",
      "summary": "Event from 20:00 to 8:00"
    }]
  })
})

const eventMultipleDaySpan = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916466712-90992@ical.marudot.com
DTSTART;TZID=Europe/Berlin:20250326T200000
DTEND;TZID=Europe/Berlin:20250329T180000
SUMMARY:Event from 20:00 to 18:00
END:VEVENT
END:VCALENDAR`;

test('eventMultipleDaySpan', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventMultipleDaySpan, new Date('2025-03-01'), new Date('2025-03-31'));

  expect(x).toEqual({
    ok: true,
    // value: ['2025-03-26', '2025-03-27', '2025-03-28', '2025-03-29']
    value: [{
      "start": "2025-03-26",
      "end": "2025-03-29",
      "summary": "Event from 20:00 to 18:00"
    }]
  })
})

// Test for invalid date ranges (end before start) - should be filtered out
const eventInvalidDateRange = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:invalid-range@test.com
DTSTART;VALUE=DATE:20250315
DTEND;VALUE=DATE:20250310
SUMMARY:Invalid - end before start
END:VEVENT
END:VCALENDAR`;

test('eventInvalidDateRange should be filtered out', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventInvalidDateRange, new Date('2025-03-01'), new Date('2025-03-31'));

  expect(x).toEqual({
    ok: true,
    value: [] // Invalid range should be filtered out
  })
})

// Test for short overnight event that results in same-day range after hour adjustments
const eventShortOvernight = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:short-overnight@test.com
DTSTART;TZID=Europe/Berlin:20250320T230000
DTEND;TZID=Europe/Berlin:20250321T010000
SUMMARY:Short overnight event 23:00-01:00
END:VEVENT
END:VCALENDAR`;

test('eventShortOvernight should produce single day', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventShortOvernight, new Date('2025-03-01'), new Date('2025-03-31'));

  // Event from 23:00 to 01:00 next day
  // Start: 23:00 >= 12, stays on March 20
  // End: 01:00 < 12, moves to March 20
  // Both on March 20, valid same-day range
  expect(x).toEqual({
    ok: true,
    value: [{
      "start": "2025-03-20",
      "end": "2025-03-20",
      "summary": "Short overnight event 23:00-01:00"
    }]
  })
})

// ---------------------------------------------------------------------------
// Finding #1 — timezone independence of the day-blocking heuristic.
//
// A timed event at Europe/Berlin *noon* sits exactly on the default
// `hourThreshold` (12): the wall-clock hour is 12, which is NOT < 12, so the
// previous day must NOT be blocked. Read on a UTC server the old code saw hour
// 11 (12:00 CEST = 10:00 UTC in winter / 11:00 in summer) and wrongly blocked
// the prior day. The collapse now reasons on the event's own wall-clock hour,
// so this asserts the SAME output a Berlin server would produce — and the whole
// suite is run under TZ=UTC and TZ=Pacific/Kiritimati to prove it holds.
// ---------------------------------------------------------------------------
const eventBerlinNoon = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:berlin-noon@test.com
DTSTART;TZID=Europe/Berlin:20250615T120000
DTEND;TZID=Europe/Berlin:20250615T140000
SUMMARY:Berlin noon check-in
END:VEVENT
END:VCALENDAR`;

test('timezone-independent: Berlin noon start blocks only its own day', () => {
  const x = icalParserService.collapseToBlockedDateRanges(
    eventBerlinNoon,
    new Date('2025-06-01'),
    new Date('2025-06-30'),
  );

  // hour === 12 is not < 12 → no previous-day block, regardless of server TZ.
  expect(x).toEqual({
    ok: true,
    value: [{ start: '2025-06-15', end: '2025-06-15', summary: 'Berlin noon check-in' }],
  });
});

// parseEventRanges exposes the event's own wall-clock components (its TZID),
// which are what the collapse layer reasons on — never server-local getters.
test('parseEventRanges exposes timezone-own wall-clock components', () => {
  const x = icalParserService.parseEventRanges(eventBerlinNoon);

  expect(x.ok).toBe(true);
  if (!x.ok) return;
  expect(x.value).toHaveLength(1);
  const [range] = x.value;
  // 12:00 in Europe/Berlin, independent of the server's TZ.
  expect(range?.startWallClock).toMatchObject({ year: 2025, month: 6, day: 15, hour: 12 });
  expect(range?.endWallClock).toMatchObject({ year: 2025, month: 6, day: 15, hour: 14 });
});

// ---------------------------------------------------------------------------
// Finding #2 — window-boundary inclusion. The overlap filter compares calendar
// days inclusively, so blocks touching the window's edges are kept.
// ---------------------------------------------------------------------------

// A one-day all-day block on the window's very first day must be returned.
// (DTEND is exclusive: 20260707→20260708 collapses to the single day 2026-07-07.)
const eventFirstDayOfWindow = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:first-day-of-window@test.com
DTSTART;VALUE=DATE:20260707
DTEND;VALUE=DATE:20260708
SUMMARY:One-day block on window start
END:VEVENT
END:VCALENDAR`;

test('one-day block on the window first day is returned', () => {
  const x = icalParserService.collapseToBlockedDateRanges(
    eventFirstDayOfWindow,
    new Date('2026-07-07'),
    new Date('2026-07-14'),
  );

  expect(x).toEqual({
    ok: true,
    value: [{ start: '2026-07-07', end: '2026-07-07', summary: 'One-day block on window start' }],
  });
});

// A multi-day block whose collapsed range ends exactly on windowStart must be
// returned (previously dropped by the exclusive overlap comparison).
const eventEndingOnWindowStart = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:ending-on-window-start@test.com
DTSTART;VALUE=DATE:20260705
DTEND;VALUE=DATE:20260708
SUMMARY:Block ending on window start
END:VEVENT
END:VCALENDAR`;

test('multi-day block ending on windowStart is returned', () => {
  const x = icalParserService.collapseToBlockedDateRanges(
    eventEndingOnWindowStart,
    new Date('2026-07-07'),
    new Date('2026-07-14'),
  );

  // 20260705→20260708 (exclusive) collapses to 2026-07-05 … 2026-07-07; the
  // range's last day equals windowStart and must overlap inclusively.
  expect(x).toEqual({
    ok: true,
    value: [{ start: '2026-07-05', end: '2026-07-07', summary: 'Block ending on window start' }],
  });
});

// A block entirely before the window must still be excluded.
const eventBeforeWindow = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:before-window@test.com
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260604
SUMMARY:Block before window
END:VEVENT
END:VCALENDAR`;

test('block entirely before the window is excluded', () => {
  const x = icalParserService.collapseToBlockedDateRanges(
    eventBeforeWindow,
    new Date('2026-07-07'),
    new Date('2026-07-14'),
  );

  expect(x).toEqual({ ok: true, value: [] });
});

// Pathological RRULE: FREQ=SECONDLY over a 12-month window would yield
// ~31M occurrences without a guard. The parser must cap iteration so a
// malicious or buggy feed can't spin the worker indefinitely.
const eventPathologicalSecondly = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250101T000000Z
UID:pathological-secondly@test.com
DTSTART;TZID=Europe/Berlin:20250101T100000
DTEND;TZID=Europe/Berlin:20250101T100100
RRULE:FREQ=SECONDLY
SUMMARY:Pathological secondly RRULE
END:VEVENT
END:VCALENDAR`;

test('collapseToBlockedDateRanges caps occurrences for pathological RRULE', () => {
  const startTime = performance.now();
  const result = icalParserService.collapseToBlockedDateRanges(
    eventPathologicalSecondly,
    new Date('2025-01-01'),
    new Date('2026-01-01')
  );
  const elapsed = performance.now() - startTime;

  expect(result.ok).toBe(true);
  // Cap is 5000; produced ranges may be filtered further by overlap, but
  // the key assertion is that we didn't iterate millions of occurrences.
  if (result.ok) {
    expect(result.value.length).toBeLessThanOrEqual(5000);
  }
  // Should complete fast — without a cap, this would take many seconds.
  expect(elapsed).toBeLessThan(2000);
});
