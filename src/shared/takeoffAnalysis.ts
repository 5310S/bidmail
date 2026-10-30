// Turns a Leopard takeoff into bid packages: items grouped by trade (CSI division), with quantity
// totals per unit, ready to create trades and fill request-for-bid emails ({{takeoff_quantities}}).
import { STANDARD_TRADES } from './types'
import { leopardQuantity, leopardUnit, measuredQuantity } from './leopardQuantity'

export interface TakeoffLine {
  description: string
  quantity: number | null
  unit: string
  csiCode: string
  trade: string
  sheet: string
  notes: string
  /** Leopard's item id (for a link that opens Leopard on the item). */
  itemId: string
  /** Why there's no quantity: not measured yet, or measured only on sheets with no scale. */
  issue: '' | 'unmeasured' | 'unscaled'
}

export interface TradePackage {
  key: string
  tradeName: string
  csiCode: string
  lines: TakeoffLine[]
  totals: { unit: string; quantity: number }[]
}

// CSI MasterFormat divisions, for items tagged with a division but no trade name.
const DIVISIONS: Record<string, string> = {
  '02': 'Demolition', '03': 'Concrete', '04': 'Masonry', '05': 'Metals', '06': 'Wood & Plastics', '07': 'Thermal & Moisture Protection',
  '08': 'Doors & Windows', '09': 'Finishes', '10': 'Specialties', '11': 'Equipment', '12': 'Furnishings', '13': 'Special Construction',
  '14': 'Conveying Equipment', '21': 'Fire Suppression', '22': 'Plumbing', '23': 'HVAC', '26': 'Electrical', '27': 'Communications',
  '28': 'Electronic Safety & Security', '31': 'Earthwork', '32': 'Exterior Improvements', '33': 'Utilities'
}

const pick = (o: any, ...keys: string[]): any => {
  for (const k of keys) {
    const v = k.split('.').reduce((x, p) => (x == null ? x : x[p]), o)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const normCsi = (s: string) => {
  const d = s.replace(/[^\d]/g, '')
  if (d.length < 2) return ''
  const six = (d + '0000').slice(0, 6)
  return `${six.slice(0, 2)} ${six.slice(2, 4)} ${six.slice(4, 6)}`
}

/** True for Leopard's own takeoff file (TakeoffData): items plus the sections measured on each page. */
export const isLeopardTakeoff = (raw: any) => !!raw && Array.isArray(raw.items) && Array.isArray(raw.sections)

/** A Leopard item's quantity. Leopard computes it from the measured points and page scales. */
export type QuantityFn = (item: any, takeoff: any) => number | null

/** Lines from Leopard's TakeoffData: one per item, with its quantity as Leopard's estimate shows it and its sheets. */
export function leopardLines(raw: any, quantityOf: QuantityFn = leopardQuantity): TakeoffLine[] {
  const sheets = raw.sheets ?? {}
  const sheetName = (page: any) => {
    const s = Array.isArray(sheets) ? sheets[Number(page)] : sheets[page]
    return String((typeof s === 'string' ? s : s?.name) ?? '').trim() || (page == null ? '' : `p${Number(page) + 1}`)
  }
  const pagesByItem = new Map<string, Set<any>>()
  for (const s of raw.sections ?? []) {
    if (s?.itemId == null) continue
    const set = pagesByItem.get(String(s.itemId)) ?? new Set()
    set.add(s.page)
    pagesByItem.set(String(s.itemId), set)
  }
  return (raw.items as any[])
    .filter((it) => it && (it.name || it.id))
    .map((it) => {
      const pages = [...(pagesByItem.get(String(it.id)) ?? [])].sort((a, b) => Number(a) - Number(b))
      let q: number | null = null
      try {
        q = quantityOf(it, raw)
      } catch {
        q = null
      }
      let issue: TakeoffLine['issue'] = ''
      if (q == null) {
        const m = measuredQuantity(raw, it)
        issue = m.sections && m.unscaled === m.sections ? 'unscaled' : 'unmeasured'
      }
      return {
        description: String(it.name ?? '').trim() || 'Item',
        quantity: q,
        unit: leopardUnit(it).trim().toUpperCase(),
        itemId: String(it.id ?? ''),
        issue,
        csiCode: normCsi(String(it.csi ?? it.csiCode ?? '')),
        trade: String(it.trade ?? '').trim(),
        sheet: pages.map(sheetName).filter(Boolean).join(', '),
        notes: [it.system, it.notes].filter((x) => x && String(x).trim()).join(' - ')
      }
    })
}

/** Accepts Leopard's takeoff JSON (or a plain item list in any reasonable shape) and returns clean lines. */
export function normalizeTakeoff(raw: any, quantityOf?: QuantityFn): TakeoffLine[] {
  if (isLeopardTakeoff(raw)) return leopardLines(raw, quantityOf)
  const list: any[] = Array.isArray(raw) ? raw : pick(raw, 'items', 'takeoff.items', 'lines', 'conditions', 'measurements', 'data.items') ?? []
  return list
    .map((it) => {
      const q = pick(it, 'quantity', 'qty', 'total', 'value', 'amount')
      const qty = q == null ? null : Number(String(q).replace(/[,\s]/g, ''))
      return {
        description: String(pick(it, 'description', 'name', 'label', 'condition', 'title') ?? '').trim(),
        quantity: qty == null || isNaN(qty) ? null : qty,
        unit: String(pick(it, 'unit', 'uom', 'units', 'unitOfMeasure') ?? '').trim().toUpperCase(),
        csiCode: normCsi(String(pick(it, 'csiCode', 'csi', 'csi_code', 'costCode', 'division', 'csiDivision') ?? '')),
        trade: String(pick(it, 'trade', 'tradeName', 'scope', 'category', 'group') ?? '').trim(),
        sheet: String(pick(it, 'sheet', 'page', 'sheetName', 'sheetNumber') ?? '').trim(),
        notes: String(pick(it, 'notes', 'note', 'comment') ?? '').trim(),
        itemId: String(pick(it, 'id', 'itemId') ?? ''),
        issue: (qty == null || isNaN(qty) ? 'unmeasured' : '') as TakeoffLine['issue']
      }
    })
    .filter((l) => l.description || l.quantity != null)
}

/** The trade name for a line: its trade tag, else a standard trade matching its CSI code, else the CSI division. */
export function tradeForLine(l: TakeoffLine): { name: string; csiCode: string } {
  if (l.trade) {
    const std = STANDARD_TRADES.find((t) => t.name.toLowerCase() === l.trade.toLowerCase())
    return { name: std?.name ?? l.trade, csiCode: std?.csi ?? l.csiCode }
  }
  if (l.csiCode) {
    const exact = STANDARD_TRADES.find((t) => t.csi === l.csiCode)
    if (exact) return { name: exact.name, csiCode: exact.csi }
    // The closest standard trade: same section group (07 54 00 roofing membrane -> 07 50 00 Roofing), then division.
    const group = STANDARD_TRADES.filter((t) => t.csi.slice(0, 4) === l.csiCode.slice(0, 4))
    if (group.length === 1) return { name: group[0].name, csiCode: group[0].csi }
    const div = l.csiCode.slice(0, 2)
    const inDiv = STANDARD_TRADES.filter((t) => t.csi.startsWith(div))
    if (inDiv.length === 1) return { name: inDiv[0].name, csiCode: inDiv[0].csi }
    return { name: DIVISIONS[div] ?? `Division ${div}`, csiCode: `${div} 00 00` }
  }
  return { name: 'Unassigned', csiCode: '' }
}

/** Groups takeoff lines into one package per trade, with totals per unit. */
export function packageTakeoff(lines: TakeoffLine[]): TradePackage[] {
  const map = new Map<string, TradePackage>()
  // Items tagged with a trade first, so untagged items with the same CSI code join that trade.
  const ordered = [...lines.filter((l) => l.trade), ...lines.filter((l) => !l.trade)]
  for (const l of ordered) {
    let t = tradeForLine(l)
    if (!l.trade && l.csiCode) {
      const same = [...map.values()].find((p) => p.csiCode === l.csiCode)
      if (same) t = { name: same.tradeName, csiCode: same.csiCode }
    }
    const key = t.name.toLowerCase()
    const p = map.get(key) ?? { key, tradeName: t.name, csiCode: t.csiCode, lines: [], totals: [] }
    p.lines.push(l)
    if (l.quantity != null) {
      const tot = p.totals.find((x) => x.unit === l.unit)
      if (tot) tot.quantity += l.quantity
      else p.totals.push({ unit: l.unit, quantity: l.quantity })
    }
    map.set(key, p)
  }
  const last = (p: TradePackage) => (p.tradeName === 'Unassigned' ? 1 : 0)
  return [...map.values()].sort((a, b) => last(a) - last(b) || (a.csiCode || '99').localeCompare(b.csiCode || '99') || a.tradeName.localeCompare(b.tradeName))
}

const words = (s: string) => s.toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((w) => w && w !== 'and')

/**
 * The job's trade a takeoff package belongs to: same name, then same CSI code, then a name that contains the
 * other ("Drywall" -> "Drywall & Framing") when only one trade fits.
 */
export function matchTrade<T extends { name: string; csiCode: string }>(pkg: { tradeName: string; csiCode: string }, trades: T[]): T | undefined {
  const name = pkg.tradeName.toLowerCase().trim()
  const exact = trades.find((t) => t.name.toLowerCase().trim() === name)
  if (exact || pkg.tradeName === 'Unassigned') return exact
  if (pkg.csiCode) {
    const byCsi = trades.filter((t) => t.csiCode === pkg.csiCode)
    if (byCsi.length === 1) return byCsi[0]
  }
  const pw = words(pkg.tradeName)
  if (!pw.length) return undefined
  const fits = trades.filter((t) => {
    const tw = words(t.name)
    return pw.every((w) => tw.includes(w)) || (tw.length > 0 && tw.every((w) => pw.includes(w)))
  })
  return fits.length === 1 ? fits[0] : undefined
}

export function fmtQty(q: number | null, unit: string): string {
  if (q == null) return unit
  const n = Math.round(q * 10) / 10 // as Leopard shows them: one decimal place
  return `${n.toLocaleString('en-US')} ${unit}`.trim()
}

/** Plain-text quantity list for a trade, used by {{takeoff_quantities}} in request-for-bid emails. */
export function quantitiesText(lines: Pick<TakeoffLine, 'description' | 'quantity' | 'unit' | 'sheet'>[]): string {
  return lines.map((l) => `- ${l.description}${l.quantity == null ? '' : ': ' + fmtQty(l.quantity, l.unit)}${l.sheet ? ` (sheet ${l.sheet})` : ''}`).join('\n')
}