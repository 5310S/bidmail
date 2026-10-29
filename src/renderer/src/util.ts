export const isMac = window.bidmail?.platform === 'darwin'
/** Modifier key name for shortcuts shown in the UI. */
export const modKey = isMac ? '⌘' : 'Ctrl'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit'
  })
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtFullDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Short date for message lists: time if today, "Mon" within a week, else month/day. */
export function fmtListDate(iso: string): string {
  const d = new Date(iso)
  const n = new Date()
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const diff = (n.getTime() - d.getTime()) / 86400000
  if (diff < 6 && diff > 0) return d.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' })
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return ''
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 === 0 ? 0 : 2 })
}

export function parseMoney(s: string): number | null {
  const v = parseFloat(s.replace(/[$,\s]/g, ''))
  return isNaN(v) ? null : v
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

/** ISO string -> value for <input type="datetime-local">. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export function dueInfo(iso: string | null): { label: string; tone: 'none' | 'past' | 'soon' | 'week' | 'later' } {
  if (!iso) return { label: 'No due date', tone: 'none' }
  const d = new Date(iso)
  const ms = d.getTime() - Date.now()
  const days = ms / 86400000
  if (ms < 0) return { label: 'Bid date passed', tone: 'past' }
  if (days < 1) {
    const h = Math.max(1, Math.round(ms / 3600000))
    return { label: `Due in ${h} hour${h === 1 ? '' : 's'}`, tone: 'soon' }
  }
  if (days < 2) return { label: 'Due tomorrow', tone: 'soon' }
  if (days < 7) return { label: `Due in ${Math.ceil(days)} days`, tone: 'week' }
  return { label: `Due in ${Math.ceil(days)} days`, tone: 'later' }
}

export function addrText(list: { name: string; address: string }[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')
}

export function displayName(a?: { name: string; address: string }): string {
  if (!a) return '(unknown)'
  return a.name || a.address
}

/** Minimal RFC 4180 CSV parser (handles quotes, commas and newlines in fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else q = false
      } else field += c
    } else if (c === '"') q = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim()))
}

export function initials(name: string): string {
  const p = name.trim().split(/\s+/)
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? (p[p.length - 1][0] ?? '') : '')).toUpperCase() || '?'
}

const AVATAR_COLORS = ['#2f6fdb', '#d9622b', '#2e9d6a', '#8a4fd1', '#c23d5f', '#1f8ea3', '#b8860b', '#5a6b84']
export function colorFor(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

export function splitAddresses(s: string): string[] {
  return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean)
}

export function emailOf(s: string): string {
  const m = s.match(/<([^>]+)>/)
  return (m ? m[1] : s).trim().toLowerCase()
}
export function randomId(): string {
  return crypto.randomUUID()
}
