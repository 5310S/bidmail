// A stand-in for Leopard's server (tools/cloud.mjs on leopard.5310s.com), with the same rules:
// cookie sign-in, Origin check on non-GET requests, per-job storage and a per-account quota (507 when full).
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface MockLeopard {
  url: string
  close: () => Promise<void>
  users: Map<string, { password: string; jobs: Map<string, { job: any; takeoff: string | null; saved: number | null; files: Map<string, Buffer> }> }>
  sessions: Map<string, string>
  quota: number
  requests: { method: string; path: string; origin?: string; cookie?: string }[]
}

// Scales are real feet per PDF point. Sheet 4 (E-201) has no scale yet; a detail region on sheet 1 has its own.
const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
export const SAMPLE_TAKEOFF = {
  version: 1,
  info: { number: '24-117', location: 'Springfield', bidDate: '2026-11-20', estimator: 'Kei' },
  sheets: { 0: { name: 'A-101', folder: 'Architectural' }, 1: { name: 'A-102' }, 4: { name: 'E-201' } },
  scales: { 0: { sx: 0.5, sy: 0.5, label: '1/8" = 1\'' }, 1: { sx: 0.5, sy: 0.5, label: '1/8" = 1\'' } },
  regions: [{ id: 'r1', page: 1, name: 'Detail 3', rect: [300, 300, 400, 400], scale: { sx: 0.1, sy: 0.1, label: '1" = 1\'' } }],
  items: [
    { id: 'i1', name: 'Slab on grade 4"', kind: 'area', trade: 'Concrete', csi: '03 30 00', color: '#888', visible: true },
    { id: 'i2', name: 'Footings', kind: 'linear', csi: '033000', quantity: '1,180', color: '#888', visible: true },
    { id: 'i3', name: 'Gyp board partitions', kind: 'linear', trade: 'Drywall', height: 10, measure: 'wallArea', color: '#888', visible: true },
    { id: 'i4', name: 'Duplex receptacles', kind: 'count', csi: '26 27 26', color: '#888', visible: true },
    { id: 'i5', name: 'Light fixtures type A', kind: 'count', csi: '26', color: '#888', visible: true },
    { id: 'i6', name: 'Misc. item', kind: 'count', color: '#888', visible: true },
    { id: 'i7', name: 'Conduit', kind: 'linear', csi: '26 05 33', color: '#888', visible: true }
  ],
  sections: [
    // 100 x 50 ft with a 10 x 10 ft hole = 4,900 SF, plus 50 x 50 ft on A-102 = 7,400 SF
    { id: 's1', itemId: 'i1', page: 0, points: rect(0, 0, 200, 100), holes: [rect(10, 10, 20, 20)] },
    { id: 's2', itemId: 'i1', page: 1, points: rect(0, 0, 100, 100) },
    // 75 ft of wall x 10 ft = 750 SF, plus 10 ft in the 1" detail = 100 SF
    { id: 's3', itemId: 'i3', page: 1, points: [[0, 0], [100, 0], [100, 50]] },
    { id: 's4', itemId: 'i3', page: 1, points: [[300, 300], [400, 300]] },
    { id: 's5', itemId: 'i4', page: 4, points: [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]] },
    { id: 's6', itemId: 'i5', page: 4, points: [[1, 1], [2, 2], [3, 3], [4, 4]] },
    { id: 's7', itemId: 'i7', page: 4, points: [[0, 0], [50, 0]] }
  ]
}
export async function startMockLeopard(): Promise<MockLeopard> {
  const m: MockLeopard = { url: '', close: async () => {}, users: new Map(), sessions: new Map(), quota: 10 * 1024 ** 3, requests: [] }
  const used = (email: string) => {
    let n = 0
    for (const j of m.users.get(email)?.jobs.values() ?? []) {
      n += Buffer.byteLength(JSON.stringify(j.job)) + (j.takeoff?.length ?? 0)
      for (const f of j.files.values()) n += f.length
    }
    return n
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url ?? '/', m.url)
      const p = url.pathname
      m.requests.push({ method: req.method ?? '', path: p, origin: req.headers.origin, cookie: req.headers.cookie })
      const json = (code: number, o: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
        res.end(JSON.stringify(o))
      }
      // Leopard's rule: a non-GET request with an Origin must come from Leopard's own host.
      const origin = req.headers.origin
      if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) return json(403, { error: 'Bad origin' })
      const token = /(?:^|;\s*)leopard=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      const email = token ? m.sessions.get(token) : undefined
      const user = email ? m.users.get(email) : undefined

      if (p === '/api/login' && req.method === 'POST') {
        const { email: e, password } = JSON.parse(body.toString() || '{}')
        const u = m.users.get(String(e).toLowerCase())
        if (!u || u.password !== password) return json(401, { error: 'Wrong email or password' })
        const t = randomBytes(16).toString('hex')
        m.sessions.set(t, String(e).toLowerCase())
        return json(200, { email: String(e).toLowerCase(), name: '', used: used(String(e).toLowerCase()), quota: m.quota }, { 'Set-Cookie': `leopard=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000` })
      }
      if (p === '/api/logout' && req.method === 'POST') {
        if (token) m.sessions.delete(token)
        return json(200, { ok: true }, { 'Set-Cookie': 'leopard=; Path=/; Max-Age=0' })
      }
      if (!user || !email) return json(401, { error: 'Not signed in' })
      if (p === '/api/me') return json(200, { email, name: '', used: used(email), quota: m.quota })
      if (p === '/api/jobs' && req.method === 'GET')
        return json(200, [...user.jobs.entries()].map(([id, j]) => ({ id, job: j.job, files: [...j.files.keys()], takeoffSaved: j.saved ?? 0 })))
      const jm = /^\/api\/jobs\/([^/]+)(?:\/(takeoff|files)(?:\/([^/]+))?)?$/.exec(p)
      if (!jm) return json(404, { error: 'Not found' })
      const id = decodeURIComponent(jm[1])
      const job = user.jobs.get(id)
      if (!jm[2]) {
        if (req.method === 'PUT') {
          if (!/^[a-z0-9]{4,40}$/.test(id)) return json(400, { error: 'Bad job id' })
          let info: any
          try { info = JSON.parse(body.toString()) } catch { return json(400, { error: 'Not JSON' }) }
          if (info?.id !== id) return json(400, { error: 'Job id mismatch' })
          user.jobs.set(id, { job: info, takeoff: job?.takeoff ?? null, saved: job?.saved ?? null, files: job?.files ?? new Map() })
          return json(200, { ok: true })
        }
        return json(405, { error: 'Method not allowed' })
      }
      if (!job) return json(404, { error: 'No such job' })
      if (jm[2] === 'takeoff') {
        if (req.method === 'GET') {
          if (!job.takeoff) return json(404, { error: 'Not there' })
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-Saved': String(job.saved) })
          return res.end(job.takeoff)
        }
        job.takeoff = body.toString()
        job.saved = Number(url.searchParams.get('saved')) || Date.now()
        return json(200, { ok: true })
      }
      const stored = decodeURIComponent(jm[3] ?? '')
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/.test(stored)) return json(400, { error: 'Bad file name' })
      if (req.method === 'PUT') {
        if (used(email) + body.length > m.quota) return json(507, { error: 'Storage full' })
        job.files.set(stored, body)
        return json(200, { ok: true })
      }
      const f = job.files.get(stored)
      if (!f) return json(404, { error: 'No such file' })
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(f)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  m.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) })
  return m
}

/** Adds an account with one project and its saved takeoff. */
export function seedLeopard(m: MockLeopard, email = 'kei@5310s.com', password = 'leopard-pass') {
  const jobs = new Map()
  jobs.set('riverside01', {
    job: { id: 'riverside01', name: 'Riverside Medical Office', number: '24-117', location: 'Springfield', changed: Date.now() - 3600_000, files: ['plans.pdf'], attachments: [] },
    takeoff: JSON.stringify(SAMPLE_TAKEOFF),
    saved: Date.now() - 600_000 + 0.123, // Leopard's X-Saved is the file's mtimeMs: it can have a fraction
    files: new Map([['plans.pdf', Buffer.alloc(2048)]])
  })
  jobs.set('library01', { job: { id: 'library01', name: 'County Library Reroof', number: '', location: '', changed: Date.now() - 86400_000, files: [], attachments: [] }, takeoff: null, saved: null, files: new Map() })
  jobs.set('oldjob01', { job: { id: 'oldjob01', name: 'Riverside Old Copy', number: '24-117', deleted: Date.now() - 3600_000, changed: Date.now(), files: [] }, takeoff: '{}', saved: Date.now(), files: new Map() })
  m.users.set(email, { password, jobs })
  return { email, password }
}