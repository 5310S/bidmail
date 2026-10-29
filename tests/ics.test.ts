import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEventIcs, buildReplyIcs, parseIcs } from '../src/shared/ics'

const OUTLOOK_INVITE = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:Central Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0600',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN="Pat Turner":mailto:pat@turnergc.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Kei:mailto:kei@ashlar.com',
  'DESCRIPTION:Pre-bid walk of the site.\\nBring PPE\\, hard hats required.',
  'UID:040000008200E00074C5B7101A82E0080000000',
  ' 0123456789',
  'SUMMARY;LANGUAGE=en-US:Riverside MOB - Pre-Bid Meeting',
  'DTSTART;TZID=Central Standard Time:20261103T100000',
  'DTEND;TZID=Central Standard Time:20261103T113000',
  'LOCATION:1200 Riverside Dr\\, Austin TX',
  'SEQUENCE:2',
  'BEGIN:VALARM',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

test('parses an Outlook meeting invite with a Windows time zone', () => {
  const ev = parseIcs(OUTLOOK_INVITE)!
  assert.equal(ev.method, 'REQUEST')
  assert.equal(ev.summary, 'Riverside MOB - Pre-Bid Meeting')
  assert.equal(ev.location, '1200 Riverside Dr, Austin TX')
  assert.equal(ev.description, 'Pre-bid walk of the site.\nBring PPE, hard hats required.')
  assert.equal(ev.uid, '040000008200E00074C5B7101A82E00800000000123456789', 'folded line is unfolded')
  assert.equal(ev.sequence, 2)
  // Nov 3 2026 is after DST ends (Nov 1), so Central = UTC-6.
  assert.equal(ev.start, '2026-11-03T16:00:00.000Z')
  assert.equal(ev.end, '2026-11-03T17:30:00.000Z')
  assert.equal(ev.organizer?.email, 'pat@turnergc.com')
  assert.equal(ev.organizer?.name, 'Pat Turner')
  assert.equal(ev.attendees[0].partstat, 'NEEDS-ACTION')
  assert.equal(ev.allDay, false)
})

test('IANA zones, UTC, all-day and duration', () => {
  const summer = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=America/Chicago:20260715T090000\nDURATION:PT2H\nSUMMARY:Job walk\nEND:VEVENT\nEND:VCALENDAR')!
  assert.equal(summer.start, '2026-07-15T14:00:00.000Z', 'CDT = UTC-5')
  assert.equal(summer.end, '2026-07-15T16:00:00.000Z')
  const utc = parseIcs('BEGIN:VEVENT\nDTSTART:20261104T190000Z\nEND:VEVENT')!
  assert.equal(utc.start, '2026-11-04T19:00:00.000Z')
  const allDay = parseIcs('BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261110\nSUMMARY:Bids due\nEND:VEVENT')!
  assert.equal(allDay.allDay, true)
  assert.equal(new Date(allDay.start!).getDate(), 10)
  assert.equal(parseIcs('BEGIN:VCALENDAR\nEND:VCALENDAR'), null)
})

test('builds events and RSVP replies that parse back', () => {
  const ics = buildEventIcs({
    uid: 'bid-1@bidmail', summary: 'BID DUE: Riverside, Phase 2; electrical', start: '2026-11-04T19:00:00.000Z',
    description: 'Drawings: https://x\nSpecs: https://y', remindMinutesBefore: [1440, 120]
  })
  assert.match(ics, /BEGIN:VALARM[\s\S]*TRIGGER:-PT1440M[\s\S]*TRIGGER:-PT120M/)
  assert.ok(ics.split('\r\n').every((l) => l.length <= 75), 'long lines are folded')
  const back = parseIcs(ics)!
  assert.equal(back.summary, 'BID DUE: Riverside, Phase 2; electrical')
  assert.equal(back.start, '2026-11-04T19:00:00.000Z')
  assert.equal(back.end, '2026-11-04T19:30:00.000Z')
  assert.equal(back.description, 'Drawings: https://x\nSpecs: https://y')

  const allDay = parseIcs(buildEventIcs({ uid: 'a', summary: 'x', start: new Date(2026, 10, 10).toISOString(), allDay: true }))!
  assert.equal(allDay.allDay, true)

  const reply = buildReplyIcs(parseIcs(OUTLOOK_INVITE)!, { name: 'Kei', email: 'kei@ashlar.com' }, 'ACCEPTED')
  const r = parseIcs(reply)!
  assert.equal(r.method, 'REPLY')
  assert.equal(r.uid, '040000008200E00074C5B7101A82E00800000000123456789')
  assert.equal(r.sequence, 2)
  assert.equal(r.attendees[0].partstat, 'ACCEPTED')
  assert.equal(r.attendees[0].email, 'kei@ashlar.com')
  assert.equal(r.start, '2026-11-03T16:00:00.000Z', 'original start copied verbatim')
})