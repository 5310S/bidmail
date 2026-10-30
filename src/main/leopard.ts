// Client for Leopard (the team's web takeoff software, https://leopard.5310s.com).
// Uses Leopard's own account API: POST /api/login sets a signed "leopard" cookie (90 days) that BidMail keeps
// encrypted and sends back. Non-GET requests carry the server's Origin, which Leopard checks.
import http from 'node:http'
import https from 'node:https'

export const LEOPARD_DEFAULT_URL = 'https://leopard.5310s.com'

export interface LeopardAccount {
  email: string
  usedBytes: number | null
  quotaBytes: number | null
}

export interface LeopardProject {
  id: string
  name: string
  number: string
  location: string
  changed: number | null
  takeoffSaved: number | null
  fileCount: number
  /** In Leopard's Recently deleted. */
  deleted: boolean
}

export class LeopardAuthError extends Error {}
/** The project is no longer in the signed-in Leopard account. */
export class LeopardGoneError extends Error {}

const pick = (o: any, ...keys: string[]): any => {
  for (const k of keys) {
    const v = k.split('.').reduce((x, p) => (x == null ? x : x[p]), o)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}
const num = (v: any): number | null => (v == null || v === '' || typeof v === 'object' || isNaN(Number(v)) ? null : Number(v))
const time = (v: any): number | null => (typeof v === 'string' && isNaN(Number(v)) ? Date.parse(v) || null : num(v))
const EXPIRED = 'Your Leopard sign-in has expired. Sign in again in Settings > Leopard.'
const GONE = 'This project is no longer in your Leopard account. Link the job to its project again.'

/** The account and its storage, from /api/login or /api/me: {email, name, used, quota} (bytes). */
function accountFrom(j: any): LeopardAccount {
  const quotaGb = num(pick(j, 'quotaGB', 'quotaGb', 'storage.quotaGB', 'usage.quotaGB'))
  return {
    email: String(pick(j, 'email', 'user.email', 'account.email') ?? ''),
    usedBytes: num(pick(j, 'used', 'usedBytes', 'bytes', 'usage', 'storage.used', 'storage.usedBytes', 'usage.used', 'usage.bytes', 'usage.usedBytes')),
    quotaBytes: num(pick(j, 'quota', 'quotaBytes', 'limit', 'storage.quota', 'storage.quotaBytes', 'usage.quota', 'usage.quotaBytes')) ?? (quotaGb == null ? null : quotaGb * 1024 ** 3)
  }
}

export const normalizeLeopardUrl = (u: string) => {
  let s = (u || LEOPARD_DEFAULT_URL).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  return s
}

/** Leopard's storage names: /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/ (no leading dot, 80 characters at most). */
export const safeStoredName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 80) || 'file'

export class LeopardClient {
  readonly base: string
  constructor(baseUrl: string, public cookie = '') {
    this.base = normalizeLeopardUrl(baseUrl)
  }

  get origin() {
    return new URL(this.base).origin
  }

  private request(method: string, p: string, body?: Buffer | string, type?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    const url = new URL(this.base + p)
    const lib = url.protocol === 'https:' ? https : http
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'BidMail' }
    if (this.cookie) headers.Cookie = `leopard=${this.cookie}`
    if (method !== 'GET') headers.Origin = this.origin
    if (body !== undefined) {
      headers['Content-Type'] = type ?? 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(body))
    }
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, headers, timeout: 60_000 }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('Leopard did not answer in time')))
      req.on('error', (e: any) =>
        reject(new Error(e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED' ? `Can't reach Leopard at ${this.base}` : e?.message ?? String(e)))
      )
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  private async call(method: string, p: string, body?: Buffer | string, type?: string) {
    const r = await this.request(method, p, body, type)
    if (r.status === 401) throw new LeopardAuthError(this.cookie ? EXPIRED : 'Sign in to Leopard first (Settings > Leopard).')
    if (r.status === 507) throw new Error('Your Leopard storage is full (10 GB per account). Free up space in Leopard and try again.')
    if (r.status === 429) throw new Error('Too many Leopard sign-in attempts. Wait a few minutes and try again.')
    if (r.status >= 400) throw new Error(errorText(r.body) || `Leopard answered ${r.status}`)
    return r
  }

  async login(email: string, password: string): Promise<LeopardAccount> {
    const r = await this.request('POST', '/api/login', JSON.stringify({ email: email.trim(), password }))
    if (r.status >= 400) {
      if (r.status === 429) throw new Error('Too many Leopard sign-in attempts. Wait a few minutes and try again.')
      throw new Error(errorText(r.body) || (r.status === 401 || r.status === 403 ? 'Wrong Leopard email or password' : `Leopard answered ${r.status}`))
    }
    const set = ([] as string[]).concat(r.headers['set-cookie'] ?? [])
    const c = set.map((s) => /^\s*leopard=([^;]*)/.exec(s)?.[1]).find(Boolean)
    if (!c) throw new Error('Leopard did not start a session (no sign-in cookie came back)')
    this.cookie = c
    // Leopard's login answers with the account: {email, name, used, quota}.
    const body = parse(r.body)
    if (body && pick(body, 'email', 'user.email')) return accountFrom(body)
    return this.me().catch(() => ({ email: email.trim(), usedBytes: null, quotaBytes: null }))
  }

  async logout() {
    if (!this.cookie) return
    await this.request('POST', '/api/logout', '{}').catch(() => undefined)
    this.cookie = ''
  }

  async me(): Promise<LeopardAccount> {
    const r = await this.call('GET', '/api/me')
    const j = parse(r.body) ?? {}
    const email = pick(j, 'email', 'user.email', 'account.email')
    if (!email && (j.signedIn === false || j.user === null)) throw new LeopardAuthError(this.cookie ? EXPIRED : 'Sign in to Leopard first (Settings > Leopard).')
    return accountFrom(j)
  }

  /** The account's projects; Leopard's Recently deleted ones only when asked for. */
  async projects(includeDeleted = false): Promise<LeopardProject[]> {
    const r = await this.call('GET', '/api/jobs')
    const j = parse(r.body)
    const list: any[] = Array.isArray(j) ? j : pick(j, 'jobs', 'data') ?? []
    return list
      .map((x) => {
        const info = x.job ?? x
        return {
          id: String(x.id ?? info.id ?? ''),
          name: String(pick(info, 'name', 'title') ?? 'Untitled'),
          number: String(pick(info, 'number', 'jobNumber') ?? ''),
          location: String(pick(info, 'location', 'address') ?? ''),
          changed: time(pick(info, 'changed', 'opened', 'created')),
          takeoffSaved: time(x.takeoffSaved) || null,
          fileCount: Array.isArray(x.files) ? x.files.length : 0,
          deleted: !!info.deleted
        }
      })
      .filter((p) => p.id && (includeDeleted || !p.deleted))
      .sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0))
  }

  /** The project's takeoff (Leopard's TakeoffData), or null when none has been saved yet. */
  async takeoff(id: string): Promise<{ data: any | null; saved: number | null }> {
    const r = await this.request('GET', `/api/jobs/${encodeURIComponent(id)}/takeoff`)
    // 404 "Not there": no takeoff saved yet. 404 "No such job": the project is gone from the account.
    if (r.status === 404 && /no such job/i.test(errorText(r.body))) throw new LeopardGoneError(GONE)
    if (r.status === 404 || r.status === 204) return { data: null, saved: null }
    if (r.status === 401) throw new LeopardAuthError(EXPIRED)
    if (r.status >= 400) throw new Error(errorText(r.body) || `Leopard answered ${r.status}`)
    const data = r.body.length ? parse(r.body) : null
    return { data, saved: time(r.headers['x-saved']) }
  }

  /** Saves a file into the project's Leopard storage (counts against the account's 10 GB). */
  async putFile(id: string, name: string, content: Buffer | string, type = 'application/octet-stream'): Promise<string> {
    const stored = safeStoredName(name)
    await this.call('PUT', `/api/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(stored)}`, content, type)
    return stored
  }

  /** Opens the project in Leopard (once that browser's Leopard has it: signed in, list synced). */
  projectUrl(id: string, itemId?: string) {
    return `${this.base}/?job=${encodeURIComponent(id)}${itemId ? `&item=${encodeURIComponent(itemId)}` : ''}`
  }
}

function parse(b: Buffer): any {
  try {
    return JSON.parse(b.toString('utf8'))
  } catch {
    return null
  }
}

function errorText(b: Buffer): string {
  const j = parse(b)
  const t = j ? pick(j, 'error', 'message', 'msg') : b.toString('utf8')
  return String(t ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 300)
}