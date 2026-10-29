// Minimal iCalendar (.ics) support: read meeting invites from email, write events and RSVP replies.

export interface CalendarPerson {
  name: string
  email: string
  partstat?: string
}

export interface CalendarEvent {
  method: string // REQUEST, CANCEL, REPLY, PUBLISH
  uid: string
  sequence: number
  summary: string
  description: string
  location: string
  start: string | null // ISO (UTC)
  end: string | null
  allDay: boolean
  status: string
  organizer: CalendarPerson | null
  attendees: CalendarPerson[]
  /** Original DTSTART / DTEND lines, copied verbatim into replies. */
  rawStart: string
  rawEnd: string
}

interface Prop {
  name: string
  params: Record<string, string>
  value: string
  raw: string
}

// Outlook/Exchange send Windows time zone names; map the common ones to IANA names.
const WINDOWS_ZONES: Record<string, string> = {
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'canada central standard time': 'America/Regina',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'aus eastern standard time': 'Australia/Sydney',
  'utc': 'UTC',
  'coordinated universal time': 'UTC'
}

function unescapeText(v: string) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

function escapeText(v: string) {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function parseLines(text: string): Prop[] {
  // Unfold: a line starting with space or tab continues the previous line.
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
  const out: Prop[] = []
  for (const line of unfolded.split('\n')) {
    if (!line.trim()) continue
    // The value starts at the first ':' that is not inside a quoted parameter.
    let q = false
    let idx = -1
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') q = !q
      else if (c === ':' && !q) {
        idx = i
        break
      }
    }
    if (idx < 0) continue
    const head = line.slice(0, idx)
    const value = line.slice(idx + 1)
    const parts = head.match(/(?:[^;"]+|"[^"]*")+/g) ?? [head]
    const params: Record<string, string> = {}
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=')
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
    }
    out.push({ name: parts[0].toUpperCase(), params, value, raw: line })
  }
  return out
}

/** Offset (ms) of a time zone from UTC at the given instant, using the built-in time zone database. */
function zoneOffset(utcMs: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs
}

function resolveZone(tzid: string | undefined): string | null {
  if (!tzid) return null
  const clean = tzid.replace(/^\/+/, '').trim()
  const mapped = WINDOWS_ZONES[clean.toLowerCase()] ?? clean
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: mapped })
    return mapped
  } catch {
    return null
  }
}

function parseDate(prop: Prop | undefined): { iso: string | null; allDay: boolean } {
  if (!prop) return { iso: null, allDay: false }
  const v = prop.value.trim()
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return { iso: null, allDay: false }
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined || prop.params.VALUE === 'DATE') {
    // All-day: keep the calendar date, anchored at local midnight.
    return { iso: new Date(Number(y), Number(mo) - 1, Number(d)).toISOString(), allDay: true }
  }
  const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)] as const
  if (z) return { iso: new Date(Date.UTC(...fields)).toISOString(), allDay: false }
  const zone = resolveZone(prop.params.TZID)
  if (!zone) return { iso: new Date(...fields).toISOString(), allDay: false } // floating time = local
  const guess = Date.UTC(...fields)
  let utc = guess - zoneOffset(guess, zone)
  utc = guess - zoneOffset(utc, zone) // second pass handles DST boundaries
  return { iso: new Date(utc).toISOString(), allDay: false }
}

function person(p: Prop | undefined): CalendarPerson | null {
  if (!p) return null
  return {
    name: p.params.CN ?? '',
    email: p.value.replace(/^mailto:/i, '').trim(),
    partstat: p.params.PARTSTAT
  }
}

/** Parses the first event in an iCalendar file. Returns null when there is no VEVENT. */
export function parseIcs(text: string): CalendarEvent | null {
  const props = parseLines(text)
  const method = props.find((p) => p.name === 'METHOD')?.value.trim().toUpperCase() ?? 'PUBLISH'
  const start = props.findIndex((p) => p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VEVENT')
  if (start < 0) return null
  const ev: Prop[] = []
  let depth = 0
  for (const p of props.slice(start + 1)) {
    if (p.name === 'BEGIN') depth++
    if (p.name === 'END') {
      if (depth === 0 && p.value.trim().toUpperCase() === 'VEVENT') break
      depth--
      continue
    }
    if (depth === 0) ev.push(p)
  }
  const get = (n: string) => ev.find((p) => p.name === n)
  const s = parseDate(get('DTSTART'))
  let e = parseDate(get('DTEND'))
  if (!e.iso && s.iso) {
    const dur = get('DURATION')?.value.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/)
    if (dur) {
      const ms = ((Number(dur[1] ?? 0) * 24 + Number(dur[2] ?? 0)) * 60 + Number(dur[3] ?? 0)) * 60000
      e = { iso: new Date(new Date(s.iso).getTime() + ms).toISOString(), allDay: s.allDay }
    }
  }
  return {
    method,
    uid: get('UID')?.value.trim() ?? '',
    sequence: Number(get('SEQUENCE')?.value ?? 0) || 0,
    summary: unescapeText(get('SUMMARY')?.value ?? '(no title)'),
    description: unescapeText(get('DESCRIPTION')?.value ?? ''),
    location: unescapeText(get('LOCATION')?.value ?? ''),
    start: s.iso,
    end: e.iso,
    allDay: s.allDay,
    status: (get('STATUS')?.value ?? '').toUpperCase(),
    organizer: person(get('ORGANIZER')),
    attendees: ev.filter((p) => p.name === 'ATTENDEE').map((p) => person(p)!),
    rawStart: get('DTSTART')?.raw ?? '',
    rawEnd: get('DTEND')?.raw ?? ''
  }
}

/** Folds long lines at 75 characters as RFC 5545 requires. */
function fold(line: string): string {
  if (line.length <= 75) return line
  const out: string[] = []
  for (let i = 0; i < line.length; i += i === 0 ? 75 : 74) out.push((i === 0 ? '' : ' ') + line.slice(i, i === 0 ? 75 : i + 74))
  return out.join('\r\n')
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** A standalone event (e.g. a bid due date) with an optional reminder, for "Add to calendar". */
export function buildEventIcs(o: {
  uid: string
  summary: string
  start: string
  end?: string
  description?: string
  location?: string
  url?: string
  allDay?: boolean
  remindMinutesBefore?: number[]
}): string {
  const start = new Date(o.start)
  const end = o.end ? new Date(o.end) : new Date(start.getTime() + (o.allDay ? 86400000 : 30 * 60000))
  const day = (d: Date) => `;VALUE=DATE:${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BidMail//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${o.uid}`, `DTSTAMP:${stamp(new Date())}`,
    o.allDay ? `DTSTART${day(start)}` : `DTSTART:${stamp(start)}`,
    o.allDay ? `DTEND${day(end)}` : `DTEND:${stamp(end)}`,
    `SUMMARY:${escapeText(o.summary)}`
  ]
  if (o.location) lines.push(`LOCATION:${escapeText(o.location)}`)
  if (o.description) lines.push(`DESCRIPTION:${escapeText(o.description)}`)
  if (o.url) lines.push(`URL:${o.url}`)
  for (const m of o.remindMinutesBefore ?? []) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(o.summary)}`, `TRIGGER:-PT${m}M`, 'END:VALARM')
  }
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

export type RsvpStatus = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'

/** The RSVP reply (iTIP METHOD:REPLY) sent back to the organizer of an invite. */
export function buildReplyIcs(ev: CalendarEvent, me: { name: string; email: string }, status: RsvpStatus): string {
  const cn = me.name ? `;CN="${me.name.replace(/"/g, '')}"` : ''
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BidMail//EN', 'METHOD:REPLY',
    'BEGIN:VEVENT', `UID:${ev.uid}`, `SEQUENCE:${ev.sequence}`, `DTSTAMP:${stamp(new Date())}`
  ]
  if (ev.rawStart) lines.push(ev.rawStart)
  if (ev.rawEnd) lines.push(ev.rawEnd)
  lines.push(`SUMMARY:${escapeText(ev.summary)}`)
  if (ev.organizer) lines.push(`ORGANIZER${ev.organizer.name ? `;CN="${ev.organizer.name.replace(/"/g, '')}"` : ''}:mailto:${ev.organizer.email}`)
  lines.push(`ATTENDEE;PARTSTAT=${status}${cn}:mailto:${me.email}`, 'END:VEVENT', 'END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}