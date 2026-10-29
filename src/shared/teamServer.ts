// HTTP(S) server that shares one BidStore with every teammate's BidMail app.
//   GET  /health                public status (needsSetup, https)
//   POST /auth/setup            create the first admin (needs the setup key; only while no users exist)
//   POST /auth/login            { username, password } -> { token, user }
//   POST /auth/logout           end this session
//   GET  /auth/me               the signed-in user
//   POST /auth/password         { current, next } change your own password
//   GET|POST /auth/users        list / add users (admins)
//   PATCH /auth/users/:id       edit, reset password, deactivate (admins)
//   POST /rpc                   { method, args } -> { ok, result } | { ok: false, error }
//   GET  /events                Server-Sent Events: { revision } whenever data changes
//   GET  /updates/<file>        app installers for automatic updates (public)
// Every request except /health, /auth/setup, /auth/login and /updates needs "Authorization: Bearer <session token>".
// Until the first user exists, the setup key is accepted in place of a session (older BidMail versions).
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { BidStore } from './store'
import type { TeamUser } from './types'

export interface TeamServerOptions {
  store: BidStore
  port: number
  /** Setup key: creates the first admin, and works as a shared key while no users exist. */
  key: string
  host?: string
  tls?: { key: string; cert: string }
  updatesDir?: string
  log?: (msg: string) => void
}

export interface RunningTeamServer {
  port: number
  addresses: string[]
  https: boolean
  close: () => Promise<void>
}

function same(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function lanAddresses(port: number, secure = false): string[] {
  const scheme = secure ? 'https' : 'http'
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(`${scheme}://${ni.address}:${port}`)
    }
  }
  return out.length ? out : [`${scheme}://localhost:${port}`]
}

const MIME: Record<string, string> = { '.yml': 'text/yaml', '.yaml': 'text/yaml', '.exe': 'application/octet-stream', '.zip': 'application/zip', '.dmg': 'application/x-apple-diskimage', '.blockmap': 'application/octet-stream', '.json': 'application/json' }

export function startTeamServer(opts: TeamServerOptions): Promise<RunningTeamServer> {
  const { store, key } = opts
  const log = opts.log ?? (() => {})
  const streams = new Set<http.ServerResponse>()
  const attempts = new Map<string, { n: number; until: number }>()

  const unsubscribe = store.onChange((revision) => {
    const msg = `data: ${JSON.stringify({ revision })}\n\n`
    for (const s of streams) s.write(msg)
  })
  const heartbeat = setInterval(() => {
    for (const s of streams) s.write(': ping\n\n')
  }, 25000)

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  /** Who is calling: a signed-in user, the setup key (only while no users exist), or nobody. */
  const who = (req: http.IncomingMessage, url: URL): { user: TeamUser | null; name: string } | null => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || ''
    if (!token) return null
    const user = store.sessionUser(token)
    if (user) return { user, name: user.displayName }
    if (store.userCount() === 0 && key && same(token, key)) {
      return { user: null, name: decodeURIComponent(String(req.headers['x-user'] ?? '')) }
    }
    return null
  }

  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 45 * 1024 * 1024) {
          reject(new Error('Request too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          reject(new Error('Bad JSON'))
        }
      })
      req.on('error', reject)
    })

  const throttled = (ip: string) => {
    const a = attempts.get(ip)
    return !!a && a.n >= 10 && a.until > Date.now()
  }
  const failed = (ip: string) => {
    const a = attempts.get(ip)
    if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 5 * 60000 })
    else a.n++
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const ip = req.socket.remoteAddress ?? ''
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-User')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }
    try {
      if (url.pathname === '/health') {
        return send(res, 200, { ok: true, name: 'BidMail Team Server', version: 2, revision: store.getRevision(), needsSetup: store.userCount() === 0, https: !!opts.tls })
      }

      if (url.pathname.startsWith('/updates/') && req.method === 'GET') {
        if (!opts.updatesDir) return send(res, 404, { ok: false, error: 'Updates are not hosted here' })
        const name = decodeURIComponent(url.pathname.slice('/updates/'.length))
        if (!name || name.includes('..') || /[\\/]/.test(name)) return send(res, 400, { ok: false, error: 'Bad file name' })
        const file = path.join(opts.updatesDir, name)
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { ok: false, error: 'Not found' })
        const st = fs.statSync(file)
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size })
        fs.createReadStream(file).pipe(res)
        return
      }

      if (url.pathname === '/auth/setup' && req.method === 'POST') {
        const b = await readBody(req)
        if (store.userCount() > 0) return send(res, 409, { ok: false, error: 'This server is already set up. Sign in instead.' })
        if (!key || !same(String(b.setupKey ?? ''), key)) {
          failed(ip)
          return send(res, 401, { ok: false, error: 'The setup key is wrong.' })
        }
        store.createUser({ username: b.username, displayName: b.displayName, password: b.password, role: 'admin' })
        const s = store.login(b.username, b.password)!
        log(`setup: first admin ${s.user.username}`)
        return send(res, 200, { ok: true, result: s })
      }

      if (url.pathname === '/auth/login' && req.method === 'POST') {
        if (throttled(ip)) return send(res, 429, { ok: false, error: 'Too many sign-in attempts. Wait 5 minutes and try again.' })
        const b = await readBody(req)
        const s = store.login(String(b.username ?? ''), String(b.password ?? ''))
        if (!s) {
          failed(ip)
          return send(res, 401, { ok: false, error: 'Wrong username or password.' })
        }
        attempts.delete(ip)
        log(`login: ${s.user.username}`)
        return send(res, 200, { ok: true, result: s })
      }

      const caller = who(req, url)
      if (!caller) return send(res, 401, { ok: false, error: store.userCount() ? 'Please sign in.' : 'Invalid team key', needsLogin: true })

      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        store.logout(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
        return send(res, 200, { ok: true, result: true })
      }
      if (url.pathname === '/auth/me') return send(res, 200, { ok: true, result: caller.user })
      if (url.pathname === '/auth/password' && req.method === 'POST') {
        if (!caller.user) return send(res, 400, { ok: false, error: 'Sign in with a user account first.' })
        const b = await readBody(req)
        if (!store.login(caller.user.username, String(b.current ?? ''))) return send(res, 401, { ok: false, error: 'Your current password is wrong.' })
        store.updateUser(caller.user.id, { password: String(b.next ?? '') })
        return send(res, 200, { ok: true, result: store.login(caller.user.username, String(b.next))! })
      }
      if (url.pathname.startsWith('/auth/users')) {
        const isAdmin = caller.user?.role === 'admin' || (store.userCount() === 0 && !caller.user)
        if (!isAdmin) return send(res, 403, { ok: false, error: 'Only admins can manage users.' })
        if (url.pathname === '/auth/users' && req.method === 'GET') return send(res, 200, { ok: true, result: store.listUsers() })
        if (url.pathname === '/auth/users' && req.method === 'POST') {
          const b = await readBody(req)
          return send(res, 200, { ok: true, result: store.createUser(b) })
        }
        const m = url.pathname.match(/^\/auth\/users\/([\w-]+)$/)
        if (m && req.method === 'PATCH') {
          const b = await readBody(req)
          return send(res, 200, { ok: true, result: store.updateUser(m[1], b) })
        }
        return send(res, 404, { ok: false, error: 'Not found' })
      }

      if (url.pathname === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write(`data: ${JSON.stringify({ revision: store.getRevision() })}\n\n`)
        streams.add(res)
        req.on('close', () => streams.delete(res))
        return
      }

      if (url.pathname === '/rpc' && req.method === 'POST') {
        const { method, args } = await readBody(req)
        const result = store.call(String(method), args ?? [], caller.name)
        log(`${caller.name || 'anonymous'}: ${method}`)
        return send(res, 200, { ok: true, result: result ?? null })
      }

      return send(res, 404, { ok: false, error: 'Not found' })
    } catch (e: any) {
      return send(res, 400, { ok: false, error: e?.message ?? String(e) })
    }
  }

  const server = opts.tls
    ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }, (q, s) => void handler(q, s))
    : http.createServer((q, s) => void handler(q, s))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : opts.port
      resolve({
        port,
        https: !!opts.tls,
        addresses: lanAddresses(port, !!opts.tls),
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat)
            unsubscribe()
            for (const s of streams) s.end()
            streams.clear()
            server.close(() => done())
            server.closeAllConnections?.()
          })
      })
    })
  })
}