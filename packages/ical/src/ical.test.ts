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

const eventFrom04to16 = `BEGIN:VCALENDAR
VERSION:2.0
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTAMP:20250325T152848Z
UID:1742916341773-95418@ical.marudot.com
DTSTART;TZID=Europe/Berlin:20250316T160000
DTEND;TZID=Europe/Berlin:20250316T190000
SUMMARY:Event from 16:00 to 23:00
END:VEVENT
END:VCALENDAR`;

test('eventFrom04to16', () => {
  const x = icalParserService.collapseToBlockedDateRanges(eventFrom04to16, new Date('2025-03-01'), new Date('2025-03-31'));

  expect(x).toEqual({
    ok: true,
    value: [{
              "end": "2025-03-16",
              "start": "2025-03-16",
              "summary": "Event from 16:00 to 23:00"
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
