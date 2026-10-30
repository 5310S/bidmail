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

export const SAMPLE_TAKEOFF = {
  info: { number: '24-117', location: 'Springfield', bidDate: '2026-11-20', estimator: 'Kei' },
  sheets: { 0: { name: 'A-101', folder: 'Architectural' }, 1: { name: 'A-102' }, 4: { name: 'E-201' } },
  scales: {},
  items: [
    { id: 'i1', name: 'Slab on grade 4"', kind: 'area', trade: 'Concrete', csi: '03 30 00', unit: 'SF', quantity: 12450.5 },
    { id: 'i2', name: 'Footings', kind: 'linear', csi: '033000', quantity: '1,180' },
    { id: 'i3', name: 'Gyp board partitions', kind: 'linear', trade: 'Drywall', quantity: 2210 },
    { id: 'i4', name: 'Duplex receptacles', kind: 'count', csi: '26 27 26', quantity: 146 },
    { id: 'i5', name: 'Light fixtures type A', kind: 'count', csi: '26', quantity: 88 },
    { id: 'i6', name: 'Misc. item', kind: 'count' }
  ],
  sections: [
    { itemId: 'i1', page: 0, points: [] },
    { itemId: 'i1', page: 1, points: [] },
    { itemId: 'i3', page: 1, points: [] },
    { itemId: 'i4', page: 4, points: [] },
    { itemId: 'i5', page: 4, points: [] }
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
      if (req.method !== 'GET' && req.headers.origin !== new URL(m.url).origin) return json(403, { error: 'Bad origin' })
      const token = /(?:^|;\s*)leopard=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      const email = token ? m.sessions.get(token) : undefined
      const user = email ? m.users.get(email) : undefined

      if (p === '/api/login' && req.method === 'POST') {
        const { email: e, password } = JSON.parse(body.toString() || '{}')
        const u = m.users.get(String(e).toLowerCase())
        if (!u || u.password !== password) return json(401, { error: 'Wrong email or password' })
        const t = randomBytes(16).toString('hex')
        m.sessions.set(t, String(e).toLowerCase())
        return json(200, { email: e }, { 'Set-Cookie': `leopard=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000` })
      }
      if (p === '/api/logout' && req.method === 'POST') {
        if (token) m.sessions.delete(token)
        return json(200, { ok: true }, { 'Set-Cookie': 'leopard=; Path=/; Max-Age=0' })
      }
      if (!user || !email) return json(401, { error: 'Not signed in' })
      if (p === '/api/me') return json(200, { email, used: used(email), quota: m.quota })
      if (p === '/api/jobs' && req.method === 'GET')
        return json(200, [...user.jobs.entries()].map(([id, j]) => ({ id, job: j.job, files: [...j.files.keys()], takeoffSaved: j.saved })))
      const jm = /^\/api\/jobs\/([^/]+)(?:\/(takeoff|files)(?:\/([^/]+))?)?$/.exec(p)
      if (!jm) return json(404, { error: 'Not found' })
      const id = decodeURIComponent(jm[1])
      const job = user.jobs.get(id)
      if (!jm[2]) {
        if (req.method === 'PUT') {
          user.jobs.set(id, { job: JSON.parse(body.toString()), takeoff: job?.takeoff ?? null, saved: job?.saved ?? null, files: job?.files ?? new Map() })
          return json(200, { ok: true })
        }
        return json(405, { error: 'Method not allowed' })
      }
      if (!job) return json(404, { error: 'No such job' })
      if (jm[2] === 'takeoff') {
        if (req.method === 'GET') {
          if (!job.takeoff) return json(404, { error: 'No takeoff saved' })
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-Saved': String(job.saved) })
          return res.end(job.takeoff)
        }
        job.takeoff = body.toString()
        job.saved = Number(url.searchParams.get('saved')) || Date.now()
        return json(200, { ok: true })
      }
      const stored = decodeURIComponent(jm[3] ?? '')
      if (!/^[A-Za-z0-9._-]+$/.test(stored)) return json(400, { error: 'Bad file name' })
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
  jobs.set('job-riverside', {
    job: { id: 'job-riverside', name: 'Riverside Medical Office', number: '24-117', location: 'Springfield', changed: Date.now() - 3600_000, files: ['plans.pdf'], attachments: [] },
    takeoff: JSON.stringify(SAMPLE_TAKEOFF),
    saved: Date.now() - 600_000,
    files: new Map([['plans.pdf', Buffer.alloc(2048)]])
  })
  jobs.set('job-library', { job: { id: 'job-library', name: 'County Library Reroof', number: '', location: '', changed: Date.now() - 86400_000, files: [], attachments: [] }, takeoff: null, saved: null, files: new Map() })
  m.users.set(email, { password, jobs })
  return { email, password }
}