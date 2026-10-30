// Quantities for Leopard takeoff items, the same way Leopard's estimate works them out. Ported from Leopard at
// commit 5692cde: src/takeoff/model.ts, geometry.ts and calc.ts (layout, alongLayout). Leopard doesn't store
// measured quantities: they come from the points of each section (PDF points on the sheet) and the scale of its
// sheet, or of the detail region it was drawn in.
type Pt = [number, number]
interface PageScale { sx: number; sy: number }

const MEASURES: Record<string, string[]> = {
  area: ['area', 'perimeter', 'volume', 'wallArea', 'roofArea', 'members', 'memberLength', 'cost'],
  linear: ['length', 'wallArea', 'volume', 'slopeLength', 'hipLength', 'dropLength', 'members', 'memberLength', 'cost'],
  segment: ['length', 'segments', 'wallArea', 'volume', 'slopeLength', 'hipLength', 'cost'],
  count: ['count', 'cost']
}
const MEASURE_UNIT: Record<string, string> = {
  area: 'SF', perimeter: 'LF', volume: 'CY', wallArea: 'SF', roofArea: 'SF', length: 'LF', segments: 'EA', count: 'EA',
  members: 'EA', memberLength: 'LF', slopeLength: 'LF', hipLength: 'LF', dropLength: 'LF', cost: '$'
}
/** An item with a layout and a spacing: an area's joists or grid, a line's joists or beam pieces (model.ts hasLayout). */
export const hasLayout = (item: any): boolean =>
  !!item.layout && Number(item.spacing) > 0 && (item.kind === 'area' ? item.layout !== 'beam' : item.kind === 'linear' && item.layout !== 'grid')

const NEEDS: Record<string, (i: any) => boolean> = {
  members: hasLayout,
  memberLength: hasLayout,
  dropLength: (i) => i.drop !== undefined && i.drop !== null,
  cost: (i) => i.price !== undefined && i.price !== null
}

function signedArea(pts: Pt[]) {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  return a / 2
}
function areaSqFt(pts: Pt[], sx: number, sy: number) {
  return pts.length < 3 ? 0 : Math.abs(signedArea(pts)) * sx * sy
}
function lengthFt(pts: Pt[], sx: number, sy: number, closed = false) {
  let len = 0
  const n = pts.length
  const segs = closed && n > 2 ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    len += Math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy)
  }
  return len
}

const kindOf = (item: any) => (MEASURES[item?.kind] ? item.kind : 'count')
export const itemMeasures = (item: any) => MEASURES[kindOf(item)].filter((m) => NEEDS[m]?.(item) ?? true)
export function itemMeasure(item: any): string {
  const ms = itemMeasures(item)
  return item.measure && ms.includes(item.measure) ? item.measure : ms[0]
}
/** The item's unit: its own, else the unit of what it measures (SF, LF, EA, CY...). */
export const leopardUnit = (item: any): string => String(item?.unit || MEASURE_UNIT[itemMeasure(item)] || '')

// ---------- layouts (calc.ts) ----------
interface LayoutSpec { kind: 'joist' | 'grid'; spacing: number; spacing2?: number; angle: number }
interface Layout { members: number; length: number }

/** Members laid across an area (outer ring and holes) at sx, sy feet per point: one at each edge and every spacing between. */
export function layout(rings: Pt[][], sx: number, sy: number, spec: LayoutSpec): Layout {
  const out: Layout = { members: 0, length: 0 }
  const families: [number, number][] = [[spec.angle, spec.spacing]]
  if (spec.kind === 'grid') families.push([spec.angle + 90, spec.spacing2 ?? spec.spacing])
  const ft = rings.filter((r) => r.length >= 3).map((r) => r.map(([x, y]): Pt => [x * sx, y * sy]))
  if (!ft.length) return out
  for (const [angle, spacing] of families) {
    if (!(spacing > 0)) continue
    const a = (angle * Math.PI) / 180
    const d: Pt = [Math.cos(a), -Math.sin(a)] // along the members (sheet y runs down)
    const n: Pt = [Math.sin(a), Math.cos(a)] // across them
    const dot = (p: Pt, v: Pt) => p[0] * v[0] + p[1] * v[1]
    const offs = ft[0].map((p) => dot(p, n))
    const lo = Math.min(...offs)
    const hi = Math.max(...offs)
    const width = hi - lo
    if (width <= 0) continue
    const eps = width * 1e-9
    const at: number[] = []
    for (let k = 0; lo + k * spacing < hi - eps; k++) at.push(lo + k * spacing)
    at.push(hi)
    if (at.length > 20000) continue // a spacing far too small for the area
    for (const o0 of at) {
      // Members on the area's edges are moved in a hair, so they meet the edge they lie on.
      const o = Math.min(hi - eps, Math.max(lo + eps, o0))
      const ts: number[] = []
      for (const ring of ft)
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i]
          const q = ring[(i + 1) % ring.length]
          const op = dot(p, n)
          const oq = dot(q, n)
          if (op <= o === oq <= o) continue
          const u = (o - op) / (oq - op)
          ts.push(dot(p, d) + u * (dot(q, d) - dot(p, d)))
        }
      ts.sort((x, y) => x - y)
      let any = false
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const len = ts[i + 1] - ts[i]
        if (len <= 1e-6) continue
        any = true
        out.length += len
      }
      if (any) out.members++
    }
  }
  return out
}

/** Members along a run (PlanSwift's Joist Segment): one at each end and every spacing between, each `length` feet. */
export function alongLayout(pts: Pt[], sx: number, sy: number, spacing: number, length: number): Layout {
  const out: Layout = { members: 0, length: 0 }
  if (pts.length < 2 || !(spacing > 0)) return out
  const ft = pts.map(([x, y]): Pt => [x * sx, y * sy])
  const segs = ft.slice(1).map((b, i) => ({ len: Math.hypot(b[0] - ft[i][0], b[1] - ft[i][1]) }))
  const total = segs.reduce((a, s) => a + s.len, 0)
  if (total <= 0) return out
  const at: number[] = []
  for (let k = 0; k * spacing < total - total * 1e-9; k++) at.push(k * spacing)
  at.push(total)
  if (at.length > 20000) return out
  let i = 0
  let start = 0 // distance to the start of segment i
  for (const t of at) {
    while (i < segs.length - 1 && t > start + segs[i].len) start += segs[i++].len
    if (!segs[i].len) continue
    out.members++
    out.length += length
  }
  return out
}

/** An area's layout spec (joists or a grid), when it has one with a spacing (model.ts itemLayout). */
function itemLayout(item: any): LayoutSpec | undefined {
  if (item.kind !== 'area' || !item.layout || item.layout === 'beam' || !(Number(item.spacing) > 0)) return undefined
  return { kind: item.layout, spacing: Number(item.spacing), spacing2: item.spacing2 == null ? undefined : Number(item.spacing2), angle: Number(item.layoutAngle ?? 0) }
}

/** One shape's layout members at its scale (model.ts sectionLayout). */
function sectionLayout(item: any, s: any, scale: PageScale | undefined): Layout | null {
  const pts: Pt[] = s.points ?? []
  if (item.kind === 'linear' && scale && hasLayout(item)) {
    const spacing = Number(item.spacing)
    if (item.layout === 'joist') return alongLayout(pts, scale.sx, scale.sy, spacing, Number(item.memberSize ?? 0))
    // Beam pieces: the stock lengths a run takes (rounded up), and their total length.
    const n = Math.ceil(lengthFt(pts, scale.sx, scale.sy) / spacing - 1e-9)
    return { members: n, length: n * spacing }
  }
  const spec = itemLayout(item)
  return spec && scale ? layout([pts, ...(s.holes ?? [])], scale.sx, scale.sy, spec) : null
}

function regionAt(data: any, page: number, p: Pt) {
  const rs: any[] = data.regions ?? []
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i]
    if (r.page === page && p[0] >= r.rect[0] && p[0] <= r.rect[2] && p[1] >= r.rect[1] && p[1] <= r.rect[3]) return r
  }
  return undefined
}
function sectionScale(data: any, s: any): PageScale | undefined {
  const r = s.points?.length ? regionAt(data, s.page, s.points[0]) : undefined
  const sc = r ? r.scale : data.scales?.[s.page]
  return sc && Number(sc.sx) > 0 && Number(sc.sy) > 0 ? { sx: Number(sc.sx), sy: Number(sc.sy) } : undefined
}

function sectionGeometry(item: any, s: any, scale: PageScale | undefined) {
  const pts: Pt[] = s.points ?? []
  const count = pts.length
  const segments = item.kind === 'segment' ? Math.floor(count / 2) : 0
  if (!scale) return { scaled: false, area: 0, perimeter: 0, length: 0, segments, count }
  const { sx, sy } = scale
  let area = 0
  let perimeter = 0
  let length = 0
  const holes: Pt[][] = s.holes ?? []
  if (item.kind === 'area') {
    area = areaSqFt(pts, sx, sy) - holes.reduce((a, h) => a + areaSqFt(h, sx, sy), 0)
    perimeter = lengthFt(pts, sx, sy, true) + holes.reduce((a, h) => a + lengthFt(h, sx, sy, true), 0)
  } else if (item.kind === 'linear') length = lengthFt(pts, sx, sy, false)
  else if (item.kind === 'segment') for (let i = 0; i + 1 < count; i += 2) length += lengthFt([pts[i], pts[i + 1]], sx, sy)
  return { scaled: true, area: Math.max(0, area), perimeter, length, segments, count }
}

function sectionResult(item: any, s: any, scale: PageScale | undefined, m: string): number | null {
  const g = sectionGeometry(item, s, scale)
  if (m === 'cost') {
    const base = sectionResult(item, s, scale, MEASURES[kindOf(item)][0])
    return base === null ? null : base * Number(item.price ?? 0)
  }
  if (m === 'count') return g.count
  if (m === 'segments') return g.segments
  if (!g.scaled) return null
  const h = Number(item.height ?? 0), d = Number(item.depth ?? 0), w = Number(item.width ?? 0), sides = Number(item.sides ?? 1)
  const pitch = Number(item.pitch ?? 0)
  switch (m) {
    case 'area': return g.area
    case 'perimeter': return g.perimeter
    case 'roofArea': return g.area * Math.sqrt(1 + (pitch / 12) ** 2)
    case 'length': return g.length
    case 'slopeLength': return g.length * Math.sqrt(1 + (pitch / 12) ** 2)
    case 'hipLength': return g.length * Math.sqrt(1 + pitch ** 2 / 288)
    case 'dropLength': return g.length + Number(item.drop ?? 0) * g.count
    case 'wallArea': return item.kind === 'area' ? g.perimeter * h : g.length * h * sides
    case 'volume': return item.kind === 'area' ? (g.area * d) / 27 : (g.length * w * d) / 27
    case 'members': return sectionLayout(item, s, scale)?.members ?? 0
    case 'memberLength': return sectionLayout(item, s, scale)?.length ?? 0
  }
  return null
}

/** Measured quantity over all the item's sections; unscaled = sections on sheets with no scale. */
export function measuredQuantity(data: any, item: any) {
  const m = itemMeasure(item)
  let value = 0
  let sections = 0
  let unscaled = 0
  for (const s of data.sections ?? []) {
    if (String(s.itemId) !== String(item.id)) continue
    sections++
    const q = sectionResult(item, s, sectionScale(data, s), m)
    if (q === null) unscaled++
    else value += q
  }
  return { value, sections, unscaled }
}

/**
 * The item's quantity as Leopard's estimate shows it: a typed quantity wins, else the measured one.
 * null = nothing measured yet, or measured only on sheets without a scale.
 */
export function leopardQuantity(item: any, data: any): number | null {
  const typed = item?.quantity
  if (typed !== undefined && typed !== null && typed !== '') {
    const n = Number(String(typed).replace(/[,\s]/g, ''))
    return isNaN(n) ? null : n
  }
  const r = measuredQuantity(data ?? {}, item)
  if (!r.sections || r.unscaled === r.sections) return null
  return r.value
}