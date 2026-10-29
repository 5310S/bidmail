// Routes bid-tracking calls to the right place:
//   local  -> SQLite file on this PC
//   host   -> SQLite file on this PC, shared to teammates through the built-in team server (HTTP or HTTPS)
//   remote -> a teammate's (or cloud) BidMail Team Server, signed in as a team user
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { BidStore } from '../shared/store'
import { RunningTeamServer, startTeamServer } from '../shared/teamServer'
import { loadOrCreateCert } from '../shared/cert'
import { TeamSettings, TeamStatus } from '../shared/ipc'
import type { TeamUser } from '../shared/types'
import { NetError, request, stream } from './net'

type Listener = (rev: number) => void
type StatusListener = (s: TeamStatus) => void

const EMPTY: TeamStatus = {
  mode: 'local', connected: false, url: '', addresses: [], error: '', revision: 0, https: false, fingerprint: '',
  user: null, needsLogin: false, needsSetup: false, userCount: 0
}

export const normalizeUrl = (u: string) => {
  const t = u.trim().replace(/\/+$/, '')
  return !t ? '' : /^https?:\/\//i.test(t) ? t : 'http://' + t
}

export class BidBackend {
  private local: BidStore | null = null
  private server: RunningTeamServer | null = null
  private abort: AbortController | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private unsub: (() => void) | null = null
  private status: TeamStatus = { ...EMPTY }
  private team: TeamSettings = { mode: 'local', url: '', key: '', port: 4780, https: false, username: '', token: '', certPem: '' }

  constructor(
    private getUser: () => string,
    private onChange: Listener,
    private onStatus: StatusListener
  ) {}

  getStatus() {
    return this.status
  }

  private setStatus(p: Partial<TeamStatus>) {
    this.status = { ...this.status, ...p }
    this.onStatus(this.status)
  }

  private openLocal() {
    if (!this.local) {
      this.local = new BidStore(path.join(app.getPath('userData'), 'bidmail.db'))
      this.unsub = this.local.onChange((rev) => {
        this.status.revision = rev
        this.onChange(rev)
      })
    }
    return this.local
  }

  /** Folder of installers the built-in team server offers teammates for automatic updates. */
  static updatesDir() {
    const d = path.join(app.getPath('userData'), 'updates')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  async configure(team: TeamSettings) {
    await this.stop()
    this.team = { ...team, url: normalizeUrl(team.url) }
    this.status = { ...EMPTY, mode: team.mode, url: this.team.url }
    if (team.mode === 'remote') {
      if (!this.team.url) return this.setStatus({ error: 'Enter the team server address in Settings > Team Sharing.' })
      this.setStatus({ https: this.team.url.startsWith('https:') })
      if (!this.team.token && !this.team.key) return this.setStatus({ needsLogin: true, error: 'Sign in to the team server.' })
      this.refreshMe()
      this.listen()
      return
    }
    const store = this.openLocal()
    this.status.revision = store.getRevision()
    if (team.mode === 'host') {
      try {
        if (!team.key) throw new Error('Set a setup key before hosting.')
        const tls = team.https ? await loadOrCreateCert(path.join(app.getPath('userData'), 'team-cert.json')) : undefined
        this.server = await startTeamServer({
          store, port: team.port || 4780, key: team.key, tls: tls ? { key: tls.key, cert: tls.cert } : undefined,
          updatesDir: BidBackend.updatesDir()
        })
        this.setStatus({ connected: true, addresses: this.server.addresses, https: !!tls, fingerprint: tls?.fingerprint ?? '', userCount: store.userCount(), error: '' })
      } catch (e: any) {
        this.setStatus({ connected: false, error: 'Could not start team server: ' + (e?.message ?? e) })
      }
    } else {
      this.setStatus({ connected: true })
    }
  }

  async stop() {
    this.abort?.abort()
    this.abort = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.server) {
      await this.server.close()
      this.server = null
    }
  }

  async shutdown() {
    await this.stop()
    this.unsub?.()
    this.local?.close()
    this.local = null
  }

  private authHeaders(): Record<string, string> {
    if (this.team.token) return { Authorization: 'Bearer ' + this.team.token }
    return { Authorization: 'Bearer ' + this.team.key, 'X-User': encodeURIComponent(this.getUser()) }
  }

  /** Calls the team server and turns its answers into errors the user can act on. */
  private async remote(pathName: string, method = 'GET', body?: unknown): Promise<any> {
    let res: { status: number; body: any }
    try {
      res = await request(this.team.url + pathName, { method, body, headers: this.authHeaders(), pinPem: this.team.certPem || undefined })
    } catch (e: any) {
      this.setStatus({ connected: false, error: e?.message ?? String(e) })
      throw new Error(e?.message ?? String(e))
    }
    if (res.status === 401) {
      this.setStatus({ connected: false, needsLogin: true, user: null, error: 'Your team sign-in has ended. Sign in again in Settings > Team Sharing.' })
      throw new Error('Sign in to the team server (Settings > Team Sharing).')
    }
    if (!res.body?.ok) throw new Error(res.body?.error || `Team server error (${res.status})`)
    return res.body.result
  }

  async call(method: string, args: any[]): Promise<any> {
    if (this.team.mode !== 'remote') return this.openLocal().call(method, args, this.getUser())
    return this.remote('/rpc', 'POST', { method, args })
  }

  private async refreshMe() {
    try {
      const me: TeamUser | null = await this.remote('/auth/me')
      this.setStatus({ user: me, needsLogin: false })
    } catch {
      /* status already updated */
    }
  }

  /** Keeps a Server-Sent Events stream open so changes made by teammates show up immediately. */
  private async listen() {
    const ctrl = new AbortController()
    this.abort = ctrl
    let status = 0
    let buf = ''
    try {
      await stream(
        this.team.url + '/events',
        { headers: this.authHeaders(), pinPem: this.team.certPem || undefined, signal: ctrl.signal },
        (s) => {
          status = s
          if (s === 200) this.setStatus({ connected: true, error: '' })
        },
        (text) => {
          if (status !== 200) return
          buf += text
          let idx: number
          while ((idx = buf.indexOf('\n\n')) > -1) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const line = chunk.split('\n').find((l) => l.startsWith('data:'))
            if (!line) continue
            try {
              const { revision } = JSON.parse(line.slice(5))
              if (revision !== this.status.revision) {
                this.status.revision = revision
                this.onChange(revision)
              }
            } catch {
              /* ignore malformed event */
            }
          }
        }
      )
      if (status === 401) {
        this.setStatus({ connected: false, needsLogin: true, error: this.team.token ? 'Your team sign-in has ended. Sign in again.' : 'The team key was rejected by the server.' })
        return
      }
      throw new Error(status && status !== 200 ? 'HTTP ' + status : 'Connection closed')
    } catch (e: any) {
      if (ctrl.signal.aborted) return
      this.setStatus({ connected: false, error: (e?.message ?? String(e)) + ' Retrying...' })
      this.retryTimer = setTimeout(() => this.listen(), 5000)
    }
  }

  // ---------- signing in to a remote server (static: used before the backend is configured) ----------
  static async health(url: string, certPem?: string): Promise<{ needsSetup: boolean; https: boolean; version: number }> {
    const r = await request(normalizeUrl(url) + '/health', { pinPem: certPem || undefined, timeoutMs: 8000 })
    if (!r.body?.ok) throw new NetError('No BidMail Team Server found at ' + url, 'ENOTBIDMAIL')
    return { needsSetup: !!r.body.needsSetup, https: !!r.body.https, version: Number(r.body.version ?? 1) }
  }

  static async login(url: string, username: string, password: string, certPem?: string): Promise<{ token: string; user: TeamUser }> {
    const r = await request(normalizeUrl(url) + '/auth/login', { method: 'POST', body: { username, password }, pinPem: certPem || undefined })
    if (!r.body?.ok) throw new Error(r.body?.error || 'Sign-in failed')
    return r.body.result
  }

  static async setup(url: string, setupKey: string, username: string, password: string, displayName: string, certPem?: string): Promise<{ token: string; user: TeamUser }> {
    const r = await request(normalizeUrl(url) + '/auth/setup', { method: 'POST', body: { setupKey, username, password, displayName }, pinPem: certPem || undefined })
    if (!r.body?.ok) throw new Error(r.body?.error || 'Setup failed')
    return r.body.result
  }

  async logout() {
    if (this.team.mode === 'remote' && this.team.token) await this.remote('/auth/logout', 'POST').catch(() => {})
  }

  async changePassword(current: string, next: string): Promise<string> {
    const r = await this.remote('/auth/password', 'POST', { current, next })
    return r.token
  }

  // ---------- user management: host manages its own database; remote admins go through the server ----------
  async listUsers(): Promise<TeamUser[]> {
    if (this.team.mode === 'remote') return this.remote('/auth/users')
    return this.openLocal().listUsers()
  }

  async createUser(u: { username: string; displayName?: string; password: string; role?: 'admin' | 'member' }): Promise<TeamUser> {
    if (this.team.mode === 'remote') return this.remote('/auth/users', 'POST', u)
    const user = this.openLocal().createUser(u)
    this.setStatus({ userCount: this.openLocal().userCount() })
    return user
  }

  async updateUser(id: string, patch: { displayName?: string; role?: 'admin' | 'member'; active?: boolean; password?: string }): Promise<TeamUser> {
    if (this.team.mode === 'remote') return this.remote(`/auth/users/${id}`, 'PATCH', patch)
    const user = this.openLocal().updateUser(id, patch)
    this.setStatus({ userCount: this.openLocal().userCount() })
    return user
  }
}