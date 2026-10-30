// The estimator's vendor list (an Excel sheet of subcontractors by trade), and which companies get the request
// for bids for each trade from the takeoff.
import { Company, STANDARD_TRADES } from './types'

export interface VendorListResult {
  /** The sheet's title above the header row, e.g. the job name. */
  title: string
  companies: Partial<Company>[]
  skipped: number
}

const COLUMNS: [keyof typeof COL_RE, RegExp][] = []
const COL_RE = {
  phone: /phone|tel\b|cell|mobile|fax/i,
  email: /e-?mail/i,
  trade: /^(categor(y|ies)|trades?|scope|division|csi|specialty)\b/i,
  company: /company|vendor|subcontractor|firm|business name/i,
  contact: /full name|contact|^name$|estimator|first name|representative/i,
  type: /^type$|certif|m\/?wbe|^mbe|^wbe|^dbe|classification|diversity/i,
  apprentice: /apprentice/i,
  notes: /^notes?$|comments?|remarks/i
}
for (const k of Object.keys(COL_RE) as (keyof typeof COL_RE)[]) COLUMNS.push([k, COL_RE[k]])

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Reads a vendor list: finds the header row (Category, Company Name, Email...) and turns each row into a company. */
export function parseVendorList(rows: string[][]): VendorListResult {
  let header = -1
  let cols: Partial<Record<keyof typeof COL_RE, number>> = {}
  for (let i = 0; i < Math.min(rows.length, 20) && header < 0; i++) {
    const found: Partial<Record<keyof typeof COL_RE, number>> = {}
    ;(rows[i] ?? []).forEach((cell, j) => {
      const h = clean(cell)
      if (!h) return
      const hit = COLUMNS.find(([k, re]) => found[k] === undefined && re.test(h))
      if (hit) found[hit[0]] = j
    })
    if (found.company !== undefined && (found.email !== undefined || found.trade !== undefined)) {
      header = i
      cols = found
    }
  }
  if (header < 0) throw new Error("Couldn't find the header row. The sheet needs columns like Category, Company Name and Email.")
  const title = rows.slice(0, header).flat().map(clean).find(Boolean) ?? ''
  const at = (r: string[], k: keyof typeof COL_RE) => (cols[k] === undefined ? '' : clean(r[cols[k]!]))
  const companies: Partial<Company>[] = []
  let skipped = 0
  for (const r of rows.slice(header + 1)) {
    if (!r || !r.some((c) => clean(c))) continue
    const name = at(r, 'company')
    const email = (at(r, 'email').match(/[^\s;,<>"]+@[^\s;,<>"]+\.[a-z]{2,}/i)?.[0] ?? '').toLowerCase()
    if (!name || (!email && !at(r, 'phone'))) {
      skipped++
      continue
    }
    const type = at(r, 'type')
    const union = /non[\s-]?union/i.test(type) ? 'non_union' : /union/i.test(type) ? 'union' : undefined
    const certs = type.replace(/non[\s-]?union|union/gi, '').split(/[\/,;]+/).map(clean).filter(Boolean).join(', ')
    const apprentice = at(r, 'apprentice')
    const notes = [at(r, 'notes'), apprentice && `Apprentice program: ${apprentice}`].filter(Boolean).join('. ')
    companies.push({
      name,
      contactName: at(r, 'contact'),
      email,
      phone: at(r, 'phone'),
      trades: at(r, 'trade').split(/\s*[\/,;]\s*/).map(clean).filter(Boolean).join(', '),
      ...(certs ? { certifications: certs } : {}),
      ...(union ? { union } : {}),
      ...(notes ? { notes } : {})
    })
  }
  return { title, companies, skipped }
}

// ---------- matching a takeoff trade to the vendor list ----------
const STOP = new Set(['and', 'the', 'of', 'inc', 'misc', 'general'])
const words = (s: string) => s.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w))
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function close(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/** demo ~ demolition, metal ~ metals, contrete ~ concrete (a typo). */
const wordMatch = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) || (a.length >= 6 && b.length >= 6 && close(a, b))

/** Does one of a company's trades ("Store Front", "Concrete") belong to this takeoff trade? */
export function tradeCovers(companyTrade: string, takeoffTrade: string): boolean {
  const part = squash(companyTrade)
  if (!part) return false
  const names = [takeoffTrade]
  const std = STANDARD_TRADES.find((t) => t.name.toLowerCase() === takeoffTrade.toLowerCase())
  if (std) names.push(std.name)
  return names.some((name) => {
    if (part.length >= 5 && squash(name).includes(part)) return true
    const pw = words(companyTrade)
    const nw = words(name)
    return pw.length > 0 && pw.every((w) => nw.some((n) => wordMatch(w, n)))
  })
}

/** The companies from the vendor list that bid this trade. */
export function companiesForTrade<T extends { trades: string; email: string }>(companies: T[], tradeName: string, csiCode = ''): T[] {
  const alt = csiCode ? STANDARD_TRADES.find((t) => t.csi === csiCode)?.name : undefined
  return companies.filter((c) =>
    c.trades
      .split(/\s*[,\/;]\s*/)
      .some((part) => tradeCovers(part, tradeName) || (alt ? tradeCovers(part, alt) : false))
  )
}
/** Rows of a CSV file (quoted cells, commas and line breaks inside quotes). */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}