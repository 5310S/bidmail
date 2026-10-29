// BidStore: the bid-tracking database (jobs, trades, bidders, addenda, quotes, companies, templates,
// activity log, team users and change log). Used directly by the desktop app in local/host mode and by
// the team server in shared mode. Older databases are upgraded in place on open.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  ADDENDUM_TEMPLATE, Activity, Addendum, AuditEntry, Bidder, BidderAction, BidderActionInput, Company, CompanyWithStats,
  DEFAULT_TEMPLATES, EmailMatch, FileMeta, Job, JobDetail, JobSummary, TeamUser, Template, TodaySummary, Trade,
  TradeWithBidders, effectiveTradeStatus
} from './types'

type Row = Record<string, any>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, number TEXT DEFAULT '', client TEXT DEFAULT '', location TEXT DEFAULT '',
  bid_due TEXT, drawings_link TEXT DEFAULT '', specs_link TEXT DEFAULT '', folder_path TEXT DEFAULT '',
  notes TEXT DEFAULT '', status TEXT DEFAULT 'bidding', created_at TEXT, updated_at TEXT, updated_by TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL,
  csi_code TEXT DEFAULT '', status TEXT DEFAULT 'auto', notes TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_job ON trades(job_id);
CREATE TABLE IF NOT EXISTS bidders (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE, company_id TEXT,
  company_name TEXT NOT NULL, contact_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
  drawings_sent_at TEXT, last_follow_up_at TEXT, follow_up_count INTEGER DEFAULT 0,
  price_received_at TEXT, price_amount REAL, declined_at TEXT, notes TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bidders_trade ON bidders(trade_id);
CREATE INDEX IF NOT EXISTS idx_bidders_job ON bidders(job_id);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, trade_id TEXT, bidder_id TEXT,
  type TEXT NOT NULL, note TEXT DEFAULT '', amount REAL, at TEXT NOT NULL, user_name TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_act_job ON activities(job_id);
CREATE INDEX IF NOT EXISTS idx_act_bidder ON activities(bidder_id);
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
  trades TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'other', subject TEXT DEFAULT '', body TEXT DEFAULT '',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS addenda (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, number TEXT DEFAULT '',
  title TEXT DEFAULT '', issued_at TEXT, link TEXT DEFAULT '', description TEXT DEFAULT '', created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_addenda_job ON addenda(job_id);
CREATE TABLE IF NOT EXISTS addendum_sends (
  addendum_id TEXT NOT NULL REFERENCES addenda(id) ON DELETE CASCADE,
  bidder_id TEXT NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  sent_at TEXT, ack_at TEXT, PRIMARY KEY (addendum_id, bidder_id)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, bidder_id TEXT,
  name TEXT NOT NULL, content_type TEXT DEFAULT 'application/octet-stream', size INTEGER DEFAULT 0, data BLOB,
  created_at TEXT, created_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_files_job ON files(job_id);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT DEFAULT '',
  role TEXT DEFAULT 'member', password_hash TEXT NOT NULL, active INTEGER DEFAULT 1, created_at TEXT, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, user_name TEXT DEFAULT '', method TEXT, summary TEXT, job_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`

// Columns added after the first release: [table, column, definition]
const MIGRATIONS: [string, string, string][] = [
  ['jobs', 'alternates', "TEXT DEFAULT '[]'"],
  ['trades', 'drawings_link', "TEXT DEFAULT ''"],
  ['trades', 'specs_link', "TEXT DEFAULT ''"],
  ['trades', 'scope_note', "TEXT DEFAULT ''"],
  ['trades', 'scope_items', "TEXT DEFAULT '[]'"],
  ['bidders', 'will_bid_at', 'TEXT'],
  ['bidders', 'inclusions', "TEXT DEFAULT ''"],
  ['bidders', 'exclusions', "TEXT DEFAULT ''"],
  ['bidders', 'quote_notes', "TEXT DEFAULT ''"],
  ['bidders', 'alternate_prices', "TEXT DEFAULT '{}'"],
  ['bidders', 'scope_json', "TEXT DEFAULT '{}'"],
  ['companies', 'gl_expires', 'TEXT'],
  ['companies', 'wc_expires', 'TEXT'],
  ['companies', 'bonding_limit', 'REAL'],
  ['companies', 'union_status', "TEXT DEFAULT ''"],
  ['companies', 'certifications', "TEXT DEFAULT ''"],
  ['companies', 'license', "TEXT DEFAULT ''"],
  ['companies', 'prequalified', 'INTEGER DEFAULT 0']
]

const MAX_FILE_BYTES = 25 * 1024 * 1024
const SESSION_DAYS = 90
const now = () => new Date().toISOString()
const json = <T>(v: unknown, fallback: T): T => {
  if (v == null || v === '') return fallback
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return fallback
  }
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pw, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}
function checkPassword(pw: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = scryptSync(pw, Buffer.from(salt, 'base64'), expected.length)
  return timingSafeEqual(actual, expected)
}

function toJob(r: Row): Job {
  return {
    id: r.id, name: r.name, number: r.number ?? '', client: r.client ?? '', location: r.location ?? '',
    bidDue: r.bid_due ?? null, drawingsLink: r.drawings_link ?? '', specsLink: r.specs_link ?? '',
    folderPath: r.folder_path ?? '', notes: r.notes ?? '', status: r.status ?? 'bidding',
    alternates: json(r.alternates, []),
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by ?? ''
  }
}
function toTrade(r: Row): Trade {
  return {
    id: r.id, jobId: r.job_id, name: r.name, csiCode: r.csi_code ?? '', status: r.status ?? 'auto',
    notes: r.notes ?? '', sortOrder: Number(r.sort_order ?? 0), drawingsLink: r.drawings_link ?? '',
    specsLink: r.specs_link ?? '', scopeNote: r.scope_note ?? '', scopeItems: json(r.scope_items, []),
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}
function toBidder(r: Row): Bidder {
  return {
    id: r.id, jobId: r.job_id, tradeId: r.trade_id, companyId: r.company_id ?? null, companyName: r.company_name,
    contactName: r.contact_name ?? '', email: r.email ?? '', phone: r.phone ?? '',
    drawingsSentAt: r.drawings_sent_at ?? null, lastFollowUpAt: r.last_follow_up_at ?? null,
    followUpCount: Number(r.follow_up_count ?? 0), priceReceivedAt: r.price_received_at ?? null,
    priceAmount: r.price_amount == null ? null : Number(r.price_amount), declinedAt: r.declined_at ?? null,
    willBidAt: r.will_bid_at ?? null, notes: r.notes ?? '',
    inclusions: r.inclusions ?? '', exclusions: r.exclusions ?? '', quoteNotes: r.quote_notes ?? '',
    alternatePrices: json(r.alternate_prices, {}), scope: json(r.scope_json, {}),
    addendaSent: {}, addendaAck: {},
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}
function toActivity(r: Row): Activity {
  return {
    id: r.id, jobId: r.job_id, tradeId: r.trade_id ?? null, bidderId: r.bidder_id ?? null, type: r.type,
    note: r.note ?? '', amount: r.amount == null ? null : Number(r.amount), at: r.at, userName: r.user_name ?? ''
  }
}
function toCompany(r: Row): Company {
  return {
    id: r.id, name: r.name, contactName: r.contact_name ?? '', email: r.email ?? '', phone: r.phone ?? '',
    trades: r.trades ?? '', notes: r.notes ?? '', glExpires: r.gl_expires ?? null, wcExpires: r.wc_expires ?? null,
    bondingLimit: r.bonding_limit == null ? null : Number(r.bonding_limit), union: r.union_status ?? '',
    certifications: r.certifications ?? '', license: r.license ?? '', prequalified: !!r.prequalified,
    createdAt: r.created_at, updatedAt: r.updated_at
  }
}
function toTemplate(r: Row): Template {
  return { id: r.id, name: r.name, kind: r.kind ?? 'other', subject: r.subject ?? '', body: r.body ?? '', updatedAt: r.updated_at }
}
function toAddendum(r: Row): Addendum {
  return {
    id: r.id, jobId: r.job_id, number: r.number ?? '', title: r.title ?? '', issuedAt: r.issued_at ?? null,
    link: r.link ?? '', description: r.description ?? '', createdAt: r.created_at
  }
}
function toFile(r: Row): FileMeta {
  return {
    id: r.id, jobId: r.job_id, bidderId: r.bidder_id ?? null, name: r.name, contentType: r.content_type ?? '',
    size: Number(r.size ?? 0), createdAt: r.created_at, createdBy: r.created_by ?? ''
  }
}
function toUser(r: Row): TeamUser {
  return {
    id: r.id, username: r.username, displayName: r.display_name || r.username, role: r.role === 'admin' ? 'admin' : 'member',
    active: !!r.active, createdAt: r.created_at, lastLoginAt: r.last_login_at ?? null
  }
}

// camelCase field -> column, per table; only these fields may be patched.
const JOB_FIELDS: Record<string, string> = {
  name: 'name', number: 'number', client: 'client', location: 'location', bidDue: 'bid_due',
  drawingsLink: 'drawings_link', specsLink: 'specs_link', folderPath: 'folder_path', notes: 'notes', status: 'status',
  alternates: 'alternates'
}
const TRADE_FIELDS: Record<string, string> = {
  name: 'name', csiCode: 'csi_code', status: 'status', notes: 'notes', sortOrder: 'sort_order',
  drawingsLink: 'drawings_link', specsLink: 'specs_link', scopeNote: 'scope_note', scopeItems: 'scope_items'
}
const BIDDER_FIELDS: Record<string, string> = {
  companyId: 'company_id', companyName: 'company_name', contactName: 'contact_name', email: 'email', phone: 'phone',
  drawingsSentAt: 'drawings_sent_at', lastFollowUpAt: 'last_follow_up_at', followUpCount: 'follow_up_count',
  priceReceivedAt: 'price_received_at', priceAmount: 'price_amount', declinedAt: 'declined_at', notes: 'notes',
  willBidAt: 'will_bid_at', inclusions: 'inclusions', exclusions: 'exclusions', quoteNotes: 'quote_notes',
  alternatePrices: 'alternate_prices', scope: 'scope_json'
}
const COMPANY_FIELDS: Record<string, string> = {
  name: 'name', contactName: 'contact_name', email: 'email', phone: 'phone', trades: 'trades', notes: 'notes',
  glExpires: 'gl_expires', wcExpires: 'wc_expires', bondingLimit: 'bonding_limit', union: 'union_status',
  certifications: 'certifications', license: 'license', prequalified: 'prequalified'
}
const ADDENDUM_FIELDS: Record<string, string> = {
  number: 'number', title: 'title', issuedAt: 'issued_at', link: 'link', description: 'description'
}

/** Methods that may be invoked through the RPC layer (local IPC or team server). */
export const STORE_METHODS = [
  'getRevision', 'listJobs', 'getJob', 'createJob', 'updateJob', 'deleteJob', 'copyTrades',
  'addTrade', 'addTrades', 'updateTrade', 'deleteTrade',
  'addBidder', 'addBidders', 'updateBidder', 'deleteBidder', 'moveBidder', 'bidderAction', 'addNote',
  'listActivities', 'listCompanies', 'saveCompany', 'deleteCompany', 'importCompanies',
  'listTemplates', 'saveTemplate', 'deleteTemplate', 'emailIndex', 'exportJobCsv',
  'addAddendum', 'updateAddendum', 'deleteAddendum', 'markAddendumSent', 'setAddendumAck',
  'addFile', 'listFiles', 'getFile', 'deleteFile', 'todaySummary', 'listAudit'
] as const
export type StoreMethod = (typeof STORE_METHODS)[number]

const READ_METHODS = new Set([
  'getRevision', 'listJobs', 'getJob', 'listActivities', 'listCompanies', 'listTemplates', 'emailIndex',
  'exportJobCsv', 'listFiles', 'getFile', 'todaySummary', 'listAudit'
])

const ACTION_LABELS: Record<string, string> = {
  drawings_sent: 'drawings sent', follow_up_call: 'called', follow_up_email: 'follow-up email', price_received: 'price received',
  declined: 'not bidding', will_bid: 'will bid', clear_will_bid: 'cleared "will bid"', clear_drawings_sent: 'cleared "drawings sent"',
  clear_follow_up: 'cleared follow-ups', clear_price: 'cleared price', clear_declined: 'cleared "not bidding"'
}

export class BidStore {
  private db: DatabaseSync
  private listeners = new Set<(rev: number) => void>()

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    this.migrate()
    const count = this.get('SELECT COUNT(*) AS c FROM templates')?.c ?? 0
    if (Number(count) === 0) for (const t of DEFAULT_TEMPLATES) this.saveTemplate(t)
    if (!this.get("SELECT id FROM templates WHERE kind = 'addendum'")) this.saveTemplate(ADDENDUM_TEMPLATE)
  }

  private migrate() {
    for (const [table, col, def] of MIGRATIONS) {
      const cols = this.all(`PRAGMA table_info(${table})`).map((c) => c.name)
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
    }
  }

  close() {
    this.db.close()
  }

  onChange(fn: (rev: number) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ---------- helpers ----------
  private all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }
  private get(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }
  private run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params)
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  private bump() {
    const rev = this.getRevision() + 1
    this.run("INSERT INTO meta(key, value) VALUES('revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(rev))
    for (const l of this.listeners) l(rev)
    return rev
  }
  private patch(table: string, fields: Record<string, string>, id: string, data: Record<string, any>) {
    const sets: string[] = []
    const vals: any[] = []
    for (const [k, v] of Object.entries(data)) {
      const col = fields[k]
      if (!col) continue
      sets.push(`${col} = ?`)
      if (v === undefined || v === null) vals.push(null)
      else if (typeof v === 'boolean') vals.push(v ? 1 : 0)
      else if (typeof v === 'object') vals.push(JSON.stringify(v))
      else vals.push(v)
    }
    if (!sets.length) return
    sets.push('updated_at = ?')
    vals.push(now())
    this.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...vals, id)
  }
  private logActivity(a: Omit<Activity, 'id'>) {
    this.run(
      'INSERT INTO activities(id, job_id, trade_id, bidder_id, type, note, amount, at, user_name) VALUES(?,?,?,?,?,?,?,?,?)',
      randomUUID(), a.jobId, a.tradeId, a.bidderId, a.type, a.note ?? '', a.amount ?? null, a.at, a.userName ?? ''
    )
  }

  // ---------- revision ----------
  getRevision(): number {
    const r = this.get("SELECT value FROM meta WHERE key = 'revision'")
    return r ? Number(r.value) : 0
  }
  // ---------- jobs ----------
  listJobs(): JobSummary[] {
    const jobs = this.all('SELECT * FROM jobs ORDER BY CASE WHEN bid_due IS NULL THEN 1 ELSE 0 END, bid_due, name').map(toJob)
    const trades = this.all('SELECT * FROM trades').map(toTrade)
    const bidders = this.all('SELECT * FROM bidders').map(toBidder)
    return jobs.map((j) => {
      const jt = trades.filter((t) => t.jobId === j.id)
      const jb = bidders.filter((b) => b.jobId === j.id)
      const withB: TradeWithBidders[] = jt.map((t) => ({ ...t, bidders: jb.filter((b) => b.tradeId === t.id) }))
      const relevant = withB.filter((t) => effectiveTradeStatus(t) !== 'not_needed')
      return {
        ...j,
        tradeCount: relevant.length,
        tradesCovered: relevant.filter((t) => effectiveTradeStatus(t) === 'covered').length,
        bidderCount: jb.length,
        invitedCount: jb.filter((b) => b.drawingsSentAt).length,
        pricedCount: jb.filter((b) => b.priceReceivedAt).length
      }
    })
  }

  getJob(id: string): JobDetail | null {
    const r = this.get('SELECT * FROM jobs WHERE id = ?', id)
    if (!r) return null
    const trades = this.all('SELECT * FROM trades WHERE job_id = ? ORDER BY sort_order, csi_code, name', id).map(toTrade)
    const bidders = this.all('SELECT * FROM bidders WHERE job_id = ? ORDER BY company_name COLLATE NOCASE', id).map(toBidder)
    const sends = this.all('SELECT s.* FROM addendum_sends s JOIN addenda a ON a.id = s.addendum_id WHERE a.job_id = ?', id)
    const byId = new Map(bidders.map((b) => [b.id, b]))
    for (const s of sends) {
      const b = byId.get(s.bidder_id)
      if (!b) continue
      if (s.sent_at) b.addendaSent[s.addendum_id] = s.sent_at
      if (s.ack_at) b.addendaAck[s.addendum_id] = s.ack_at
    }
    return {
      job: toJob(r),
      trades: trades.map((t) => ({ ...t, bidders: bidders.filter((b) => b.tradeId === t.id) })),
      addenda: this.all('SELECT * FROM addenda WHERE job_id = ? ORDER BY created_at', id).map(toAddendum),
      files: this.listFiles(id)
    }
  }

  createJob(data: Partial<Job>, userName = ''): Job {
    const id = randomUUID()
    const ts = now()
    this.run(
      `INSERT INTO jobs(id, name, number, client, location, bid_due, drawings_link, specs_link, folder_path, notes, status, alternates, created_at, updated_at, updated_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, data.name?.trim() || 'Untitled Job', data.number ?? '', data.client ?? '', data.location ?? '', data.bidDue ?? null,
      data.drawingsLink ?? '', data.specsLink ?? '', data.folderPath ?? '', data.notes ?? '', data.status ?? 'bidding',
      JSON.stringify(data.alternates ?? []), ts, ts, userName
    )
    this.bump()
    return toJob(this.get('SELECT * FROM jobs WHERE id = ?', id)!)
  }

  updateJob(id: string, data: Partial<Job>, userName = ''): Job | null {
    this.patch('jobs', JOB_FIELDS, id, data)
    this.run('UPDATE jobs SET updated_by = ? WHERE id = ?', userName, id)
    this.bump()
    const r = this.get('SELECT * FROM jobs WHERE id = ?', id)
    return r ? toJob(r) : null
  }

  deleteJob(id: string) {
    this.tx(() => {
      this.run('DELETE FROM addendum_sends WHERE addendum_id IN (SELECT id FROM addenda WHERE job_id = ?)', id)
      this.run('DELETE FROM addenda WHERE job_id = ?', id)
      this.run('DELETE FROM files WHERE job_id = ?', id)
      this.run('DELETE FROM activities WHERE job_id = ?', id)
      this.run('DELETE FROM bidders WHERE job_id = ?', id)
      this.run('DELETE FROM trades WHERE job_id = ?', id)
      this.run('DELETE FROM jobs WHERE id = ?', id)
    })
    this.bump()
    return true
  }

  /** Copies trades (with scope checklists, and optionally their companies with statuses reset) from another job. */
  copyTrades(targetJobId: string, sourceJobId: string, includeBidders = true) {
    const src = this.getJob(sourceJobId)
    if (!src) throw new Error('Source job not found')
    const ts = now()
    this.tx(() => {
      let order = Number(this.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM trades WHERE job_id = ?', targetJobId)?.m ?? 0)
      for (const t of src.trades) {
        const tid = randomUUID()
        this.run(
          `INSERT INTO trades(id, job_id, name, csi_code, status, notes, sort_order, scope_note, scope_items, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          tid, targetJobId, t.name, t.csiCode, 'auto', '', ++order, t.scopeNote, JSON.stringify(t.scopeItems), ts, ts
        )
        if (includeBidders) {
          for (const b of t.bidders) {
            this.run(
              `INSERT INTO bidders(id, job_id, trade_id, company_id, company_name, contact_name, email, phone, created_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)`,
              randomUUID(), targetJobId, tid, b.companyId, b.companyName, b.contactName, b.email, b.phone, ts, ts
            )
          }
        }
      }
    })
    this.bump()
    return true
  }

  // ---------- trades ----------
  addTrade(jobId: string, data: Partial<Trade>): Trade {
    const id = randomUUID()
    const ts = now()
    const order = Number(this.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM trades WHERE job_id = ?', jobId)?.m ?? 0) + 1
    this.run(
      `INSERT INTO trades(id, job_id, name, csi_code, status, notes, sort_order, drawings_link, specs_link, scope_note, scope_items, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, jobId, data.name?.trim() || 'New Trade', data.csiCode ?? '', data.status ?? 'auto', data.notes ?? '', data.sortOrder ?? order,
      data.drawingsLink ?? '', data.specsLink ?? '', data.scopeNote ?? '', JSON.stringify(data.scopeItems ?? []), ts, ts
    )
    this.bump()
    return toTrade(this.get('SELECT * FROM trades WHERE id = ?', id)!)
  }

  addTrades(jobId: string, list: { name: string; csiCode?: string }[]) {
    const ts = now()
    this.tx(() => {
      let order = Number(this.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM trades WHERE job_id = ?', jobId)?.m ?? 0)
      for (const t of list) {
        this.run(
          'INSERT INTO trades(id, job_id, name, csi_code, status, notes, sort_order, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
          randomUUID(), jobId, t.name, t.csiCode ?? '', 'auto', '', ++order, ts, ts
        )
      }
    })
    this.bump()
    return true
  }

  updateTrade(id: string, data: Partial<Trade>) {
    this.patch('trades', TRADE_FIELDS, id, data)
    this.bump()
    const r = this.get('SELECT * FROM trades WHERE id = ?', id)
    return r ? toTrade(r) : null
  }

  deleteTrade(id: string) {
    this.tx(() => {
      this.run('DELETE FROM activities WHERE trade_id = ?', id)
      this.run('DELETE FROM addendum_sends WHERE bidder_id IN (SELECT id FROM bidders WHERE trade_id = ?)', id)
      this.run('UPDATE files SET bidder_id = NULL WHERE bidder_id IN (SELECT id FROM bidders WHERE trade_id = ?)', id)
      this.run('DELETE FROM bidders WHERE trade_id = ?', id)
      this.run('DELETE FROM trades WHERE id = ?', id)
    })
    this.bump()
    return true
  }

  // ---------- bidders ----------
  addBidder(tradeId: string, data: Partial<Bidder>): Bidder {
    const trade = this.get('SELECT * FROM trades WHERE id = ?', tradeId)
    if (!trade) throw new Error('Trade not found')
    const id = this.insertBidder(trade.job_id, tradeId, data)
    this.bump()
    return toBidder(this.get('SELECT * FROM bidders WHERE id = ?', id)!)
  }

  addBidders(tradeId: string, list: Partial<Bidder>[]) {
    const trade = this.get('SELECT * FROM trades WHERE id = ?', tradeId)
    if (!trade) throw new Error('Trade not found')
    this.tx(() => {
      for (const b of list) this.insertBidder(trade.job_id, tradeId, b)
    })
    this.bump()
    return true
  }

  private insertBidder(jobId: string, tradeId: string, data: Partial<Bidder>) {
    const id = randomUUID()
    const ts = now()
    this.run(
      `INSERT INTO bidders(id, job_id, trade_id, company_id, company_name, contact_name, email, phone, notes, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id, jobId, tradeId, data.companyId ?? null, data.companyName?.trim() || 'New Company', data.contactName ?? '',
      data.email ?? '', data.phone ?? '', data.notes ?? '', ts, ts
    )
    return id
  }

  updateBidder(id: string, data: Partial<Bidder>) {
    this.patch('bidders', BIDDER_FIELDS, id, data)
    this.bump()
    const r = this.get('SELECT * FROM bidders WHERE id = ?', id)
    return r ? toBidder(r) : null
  }

  deleteBidder(id: string) {
    this.tx(() => {
      this.run('DELETE FROM activities WHERE bidder_id = ?', id)
      this.run('DELETE FROM addendum_sends WHERE bidder_id = ?', id)
      this.run('UPDATE files SET bidder_id = NULL WHERE bidder_id = ?', id)
      this.run('DELETE FROM bidders WHERE id = ?', id)
    })
    this.bump()
    return true
  }

  moveBidder(id: string, tradeId: string) {
    this.run('UPDATE bidders SET trade_id = ?, updated_at = ? WHERE id = ?', tradeId, now(), id)
    this.run('UPDATE activities SET trade_id = ? WHERE bidder_id = ?', tradeId, id)
    this.bump()
    return true
  }

  /** Records a status checkpoint (with date/time) for a company, and logs it in the activity history. */
  bidderAction(id: string, action: BidderAction, input: BidderActionInput = {}, userName = ''): Bidder {
    const r = this.get('SELECT * FROM bidders WHERE id = ?', id)
    if (!r) throw new Error('Company not found on this job')
    const b = toBidder(r)
    const at = input.at || now()
    const note = input.note ?? ''
    const base = { jobId: b.jobId, tradeId: b.tradeId, bidderId: b.id, at, userName, note, amount: null as number | null }
    const cleared = (what: string) => this.logActivity({ ...base, at: now(), type: 'cleared', note: `Cleared ${what}` })
    this.tx(() => {
      switch (action) {
        case 'drawings_sent':
          this.patch('bidders', BIDDER_FIELDS, id, { drawingsSentAt: at })
          this.logActivity({ ...base, type: 'drawings_sent' })
          break
        case 'follow_up_call':
        case 'follow_up_email':
          this.patch('bidders', BIDDER_FIELDS, id, { lastFollowUpAt: at, followUpCount: b.followUpCount + 1 })
          this.logActivity({ ...base, type: action })
          break
        case 'will_bid':
          this.patch('bidders', BIDDER_FIELDS, id, { willBidAt: at, declinedAt: null })
          this.logActivity({ ...base, type: 'will_bid' })
          break
        case 'price_received': {
          const amount = input.amount ?? b.priceAmount ?? null
          this.patch('bidders', BIDDER_FIELDS, id, { priceReceivedAt: at, priceAmount: amount, declinedAt: null })
          this.logActivity({ ...base, type: 'price_received', amount })
          break
        }
        case 'declined':
          this.patch('bidders', BIDDER_FIELDS, id, { declinedAt: at, willBidAt: null })
          this.logActivity({ ...base, type: 'declined' })
          break
        case 'clear_will_bid':
          this.patch('bidders', BIDDER_FIELDS, id, { willBidAt: null })
          cleared('"Will Bid"')
          break
        case 'clear_drawings_sent':
          this.patch('bidders', BIDDER_FIELDS, id, { drawingsSentAt: null })
          cleared('"Drawings Sent"')
          break
        case 'clear_follow_up':
          this.patch('bidders', BIDDER_FIELDS, id, { lastFollowUpAt: null, followUpCount: 0 })
          cleared('follow-ups')
          break
        case 'clear_price':
          this.patch('bidders', BIDDER_FIELDS, id, { priceReceivedAt: null, priceAmount: null })
          cleared('price')
          break
        case 'clear_declined':
          this.patch('bidders', BIDDER_FIELDS, id, { declinedAt: null })
          cleared('"Not Bidding"')
          break
        default:
          throw new Error('Unknown action ' + action)
      }
    })
    this.bump()
    return toBidder(this.get('SELECT * FROM bidders WHERE id = ?', id)!)
  }

  addNote(jobId: string, note: string, bidderId: string | null = null, userName = '') {
    let tradeId: string | null = null
    if (bidderId) tradeId = this.get('SELECT trade_id FROM bidders WHERE id = ?', bidderId)?.trade_id ?? null
    this.logActivity({ jobId, tradeId, bidderId, type: 'note', note, amount: null, at: now(), userName })
    this.bump()
    return true
  }

  listActivities(jobId: string, bidderId?: string | null): Activity[] {
    if (bidderId) return this.all('SELECT * FROM activities WHERE bidder_id = ? ORDER BY at DESC', bidderId).map(toActivity)
    return this.all('SELECT * FROM activities WHERE job_id = ? ORDER BY at DESC LIMIT 500', jobId).map(toActivity)
  }

  // ---------- addenda ----------
  addAddendum(jobId: string, data: Partial<Addendum>): Addendum {
    if (!this.get('SELECT id FROM jobs WHERE id = ?', jobId)) throw new Error('Job not found')
    const id = randomUUID()
    const n = Number(this.get('SELECT COUNT(*) AS c FROM addenda WHERE job_id = ?', jobId)?.c ?? 0) + 1
    this.run(
      'INSERT INTO addenda(id, job_id, number, title, issued_at, link, description, created_at) VALUES(?,?,?,?,?,?,?,?)',
      id, jobId, data.number?.trim() || String(n), data.title ?? '', data.issuedAt ?? now(), data.link ?? '', data.description ?? '', now()
    )
    this.bump()
    return toAddendum(this.get('SELECT * FROM addenda WHERE id = ?', id)!)
  }

  updateAddendum(id: string, data: Partial<Addendum>) {
    const sets: string[] = []
    const vals: any[] = []
    for (const [k, v] of Object.entries(data)) {
      if (!ADDENDUM_FIELDS[k]) continue
      sets.push(`${ADDENDUM_FIELDS[k]} = ?`)
      vals.push(v ?? null)
    }
    if (sets.length) this.run(`UPDATE addenda SET ${sets.join(', ')} WHERE id = ?`, ...vals, id)
    this.bump()
    const r = this.get('SELECT * FROM addenda WHERE id = ?', id)
    return r ? toAddendum(r) : null
  }

  deleteAddendum(id: string) {
    this.tx(() => {
      this.run('DELETE FROM addendum_sends WHERE addendum_id = ?', id)
      this.run('DELETE FROM addenda WHERE id = ?', id)
    })
    this.bump()
    return true
  }

  /** Stamps "Addendum N sent" (with date/time) on each company and logs it. */
  markAddendumSent(addendumId: string, bidderIds: string[], at?: string, userName = '') {
    const a = this.get('SELECT * FROM addenda WHERE id = ?', addendumId)
    if (!a) throw new Error('Addendum not found')
    const ts = at || now()
    this.tx(() => {
      for (const bid of bidderIds) {
        const b = this.get('SELECT id, trade_id FROM bidders WHERE id = ? AND job_id = ?', bid, a.job_id)
        if (!b) continue
        this.run(
          `INSERT INTO addendum_sends(addendum_id, bidder_id, sent_at) VALUES(?,?,?)
           ON CONFLICT(addendum_id, bidder_id) DO UPDATE SET sent_at = excluded.sent_at`,
          addendumId, bid, ts
        )
        this.logActivity({ jobId: a.job_id, tradeId: b.trade_id, bidderId: bid, type: 'addendum_sent', note: `Addendum ${a.number}${a.title ? ': ' + a.title : ''}`, amount: null, at: ts, userName })
      }
    })
    this.bump()
    return true
  }

  /** Records (or clears, with at = null) that a company acknowledged an addendum. */
  setAddendumAck(addendumId: string, bidderId: string, at: string | null = now(), userName = '') {
    const a = this.get('SELECT * FROM addenda WHERE id = ?', addendumId)
    const b = this.get('SELECT id, trade_id FROM bidders WHERE id = ?', bidderId)
    if (!a || !b) throw new Error('Addendum or company not found')
    this.run(
      `INSERT INTO addendum_sends(addendum_id, bidder_id, ack_at) VALUES(?,?,?)
       ON CONFLICT(addendum_id, bidder_id) DO UPDATE SET ack_at = excluded.ack_at`,
      addendumId, bidderId, at
    )
    if (at) this.logActivity({ jobId: a.job_id, tradeId: b.trade_id, bidderId, type: 'addendum_ack', note: `Acknowledged addendum ${a.number}`, amount: null, at, userName })
    this.bump()
    return true
  }

  // ---------- quote files ----------
  addFile(jobId: string, bidderId: string | null, name: string, contentType: string, base64: string, userName = ''): FileMeta {
    const data = Buffer.from(base64, 'base64')
    if (data.length > MAX_FILE_BYTES) throw new Error('Files over 25 MB cannot be stored. Save it to the job folder instead.')
    const id = randomUUID()
    this.run(
      'INSERT INTO files(id, job_id, bidder_id, name, content_type, size, data, created_at, created_by) VALUES(?,?,?,?,?,?,?,?,?)',
      id, jobId, bidderId, name || 'file', contentType || 'application/octet-stream', data.length, data, now(), userName
    )
    this.bump()
    return toFile(this.get('SELECT id, job_id, bidder_id, name, content_type, size, created_at, created_by FROM files WHERE id = ?', id)!)
  }

  listFiles(jobId: string): FileMeta[] {
    return this.all('SELECT id, job_id, bidder_id, name, content_type, size, created_at, created_by FROM files WHERE job_id = ? ORDER BY created_at', jobId).map(toFile)
  }

  getFile(id: string): { meta: FileMeta; base64: string } | null {
    const r = this.get('SELECT * FROM files WHERE id = ?', id)
    if (!r) return null
    return { meta: toFile(r), base64: Buffer.from(r.data as Uint8Array).toString('base64') }
  }

  deleteFile(id: string) {
    this.run('DELETE FROM files WHERE id = ?', id)
    this.bump()
    return true
  }
  // ---------- Today ----------
  /** Everything that needs attention across open jobs: follow-ups due, short trades, bids due, addenda not sent. */
  todaySummary(followUpDays = 3, nowIso?: string): TodaySummary {
    const nowMs = nowIso ? new Date(nowIso).getTime() : Date.now()
    const day = 86400000
    const jobs = this.listJobs().filter((j) => j.status === 'bidding' && (!j.bidDue || new Date(j.bidDue).getTime() > nowMs - day))
    const followUps: TodaySummary['followUps'] = []
    const shortTrades: TodaySummary['shortTrades'] = []
    const addenda: TodaySummary['addenda'] = []
    for (const js of jobs) {
      const d = this.getJob(js.id)!
      const dueMs = js.bidDue ? new Date(js.bidDue).getTime() : null
      const dueWithin2 = dueMs != null && dueMs - nowMs < 2 * day
      for (const t of d.trades) {
        const st = effectiveTradeStatus(t)
        for (const b of t.bidders) {
          if (!b.drawingsSentAt || b.priceReceivedAt || b.declinedAt) continue
          const last = [b.drawingsSentAt, b.lastFollowUpAt].filter((x): x is string => !!x).sort().pop()!
          const days = (nowMs - new Date(last).getTime()) / day
          if (days >= followUpDays || (dueWithin2 && days >= 1)) {
            followUps.push({
              bidderId: b.id, companyName: b.companyName, contactName: b.contactName, email: b.email, phone: b.phone,
              tradeName: t.name, jobId: js.id, jobName: js.name, bidDue: js.bidDue, lastContactAt: last,
              daysSince: Math.floor(days), followUpCount: b.followUpCount, willBid: !!b.willBidAt
            })
          }
        }
        const priced = t.bidders.filter((b) => b.priceReceivedAt).length
        const willBid = t.bidders.filter((b) => b.willBidAt && !b.priceReceivedAt).length
        if (st !== 'not_needed' && st !== 'covered' && priced < 3 && (dueMs == null || dueMs - nowMs < 14 * day)) {
          shortTrades.push({
            jobId: js.id, jobName: js.name, bidDue: js.bidDue, tradeId: t.id, tradeName: t.name, priced, willBid,
            invited: t.bidders.filter((b) => b.drawingsSentAt).length, companies: t.bidders.length
          })
        }
      }
      const invited = d.trades.flatMap((t) => t.bidders).filter((b) => b.drawingsSentAt && !b.declinedAt)
      for (const a of d.addenda) {
        const notSent = invited.filter((b) => !b.addendaSent[a.id]).length
        const notAck = invited.filter((b) => b.addendaSent[a.id] && !b.addendaAck[a.id]).length
        if (notSent || notAck) addenda.push({ jobId: js.id, jobName: js.name, addendumId: a.id, number: a.number, title: a.title, notSent, notAcknowledged: notAck })
      }
    }
    followUps.sort((a, b) => (a.bidDue ?? '9').localeCompare(b.bidDue ?? '9') || b.daysSince - a.daysSince)
    shortTrades.sort((a, b) => (a.bidDue ?? '9').localeCompare(b.bidDue ?? '9') || a.priced + a.willBid - (b.priced + b.willBid))
    const dueSoon = jobs.filter((j) => j.bidDue && new Date(j.bidDue).getTime() >= nowMs && new Date(j.bidDue).getTime() - nowMs < 7 * day)
    return { followUps, shortTrades, dueSoon, addenda, generatedAt: new Date(nowMs).toISOString() }
  }

  // ---------- company directory ----------
  listCompanies(search = ''): CompanyWithStats[] {
    const match = "(b.company_id = c.id OR (c.email <> '' AND lower(b.email) = lower(c.email)))"
    const stats = `,
      (SELECT COUNT(*) FROM bidders b WHERE ${match} AND b.drawings_sent_at IS NOT NULL) AS invited_count,
      (SELECT COUNT(*) FROM bidders b WHERE ${match} AND b.price_received_at IS NOT NULL) AS priced_count,
      (SELECT COUNT(*) FROM bidders b WHERE ${match} AND b.declined_at IS NOT NULL) AS declined_count,
      (SELECT MAX(b.drawings_sent_at) FROM bidders b WHERE ${match}) AS last_invited_at`
    const q = `%${search.trim()}%`
    const rows = search.trim()
      ? this.all(
          `SELECT c.* ${stats} FROM companies c WHERE c.name LIKE ? OR c.contact_name LIKE ? OR c.email LIKE ? OR c.trades LIKE ? OR c.certifications LIKE ? ORDER BY c.name COLLATE NOCASE`,
          q, q, q, q, q
        )
      : this.all(`SELECT c.* ${stats} FROM companies c ORDER BY c.name COLLATE NOCASE`)
    return rows.map((r) => ({
      ...toCompany(r),
      invitedCount: Number(r.invited_count ?? 0),
      pricedCount: Number(r.priced_count ?? 0),
      declinedCount: Number(r.declined_count ?? 0),
      lastInvitedAt: r.last_invited_at ?? null
    }))
  }

  private insertCompany(data: Partial<Company>): string {
    const id = randomUUID()
    const ts = now()
    this.run(
      `INSERT INTO companies(id, name, contact_name, email, phone, trades, notes, gl_expires, wc_expires, bonding_limit, union_status, certifications, license, prequalified, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, data.name?.trim() || 'New Company', data.contactName ?? '', (data.email ?? '').trim(), data.phone ?? '', data.trades ?? '', data.notes ?? '',
      data.glExpires ?? null, data.wcExpires ?? null, data.bondingLimit ?? null, data.union ?? '', data.certifications ?? '', data.license ?? '',
      data.prequalified ? 1 : 0, ts, ts
    )
    return id
  }

  saveCompany(data: Partial<Company>): Company {
    let id = data.id
    if (id && this.get('SELECT id FROM companies WHERE id = ?', id)) this.patch('companies', COMPANY_FIELDS, id, data)
    else id = this.insertCompany(data)
    this.bump()
    return toCompany(this.get('SELECT * FROM companies WHERE id = ?', id)!)
  }

  deleteCompany(id: string) {
    this.run('UPDATE bidders SET company_id = NULL WHERE company_id = ?', id)
    this.run('DELETE FROM companies WHERE id = ?', id)
    this.bump()
    return true
  }

  /** Imports companies; rows matching an existing company name + email are updated instead of duplicated. */
  importCompanies(rows: Partial<Company>[]) {
    let added = 0
    let updated = 0
    this.tx(() => {
      for (const r of rows) {
        if (!r.name?.trim()) continue
        const existing = this.get(
          'SELECT id FROM companies WHERE lower(name) = lower(?) AND lower(email) = lower(?)',
          r.name.trim(), (r.email ?? '').trim()
        )
        if (existing) {
          // Only fill in columns that have a value; never blank out saved details or rename.
          const fill: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(r)) {
            if (k === 'name' || k === 'id') continue
            if (typeof v === 'string' ? v.trim() : v != null) fill[k] = typeof v === 'string' ? v.trim() : v
          }
          this.patch('companies', COMPANY_FIELDS, existing.id, fill)
          updated++
        } else {
          this.insertCompany(r)
          added++
        }
      }
    })
    this.bump()
    return { added, updated }
  }

  // ---------- templates ----------
  listTemplates(): Template[] {
    return this.all('SELECT * FROM templates ORDER BY kind, name').map(toTemplate)
  }

  saveTemplate(data: Partial<Template>): Template {
    let id = data.id
    const ts = now()
    if (id && this.get('SELECT id FROM templates WHERE id = ?', id)) {
      this.run(
        'UPDATE templates SET name = ?, kind = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?',
        data.name ?? 'Template', data.kind ?? 'other', data.subject ?? '', data.body ?? '', ts, id
      )
    } else {
      id = randomUUID()
      this.run(
        'INSERT INTO templates(id, name, kind, subject, body, updated_at) VALUES(?,?,?,?,?,?)',
        id, data.name ?? 'Template', data.kind ?? 'other', data.subject ?? '', data.body ?? '', ts
      )
    }
    this.bump()
    return toTemplate(this.get('SELECT * FROM templates WHERE id = ?', id)!)
  }

  deleteTemplate(id: string) {
    this.run('DELETE FROM templates WHERE id = ?', id)
    this.bump()
    return true
  }

  // ---------- email linking ----------
  /** Every email address on an open job, so incoming mail can be tied to the job/trade/company. */
  emailIndex(): EmailMatch[] {
    const rows = this.all(
      `SELECT b.id AS bidder_id, b.email, b.company_name, t.id AS trade_id, t.name AS trade_name, j.id AS job_id, j.name AS job_name
       FROM bidders b JOIN trades t ON t.id = b.trade_id JOIN jobs j ON j.id = b.job_id
       WHERE j.status IN ('bidding', 'submitted') AND b.email <> ''`
    )
    const out: EmailMatch[] = []
    for (const r of rows) {
      for (const e of String(r.email).split(/[;,\s]+/)) {
        const email = e.trim().toLowerCase()
        if (!email.includes('@')) continue
        out.push({
          email, bidderId: r.bidder_id, companyName: r.company_name, tradeName: r.trade_name,
          tradeId: r.trade_id, jobId: r.job_id, jobName: r.job_name
        })
      }
    }
    return out
  }

  // ---------- export ----------
  exportJobCsv(jobId: string): string {
    const d = this.getJob(jobId)
    if (!d) throw new Error('Job not found')
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [
      ['Job', 'Trade', 'CSI', 'Trade Status', 'Company', 'Contact', 'Email', 'Phone', 'Drawings Sent', 'Follow-Ups',
        'Last Follow-Up', 'Will Bid', 'Price Received', 'Price', 'Not Bidding', 'Inclusions', 'Exclusions', 'Notes',
        ...d.addenda.map((a) => `Addendum ${a.number} Sent`)].join(',')
    ]
    for (const t of d.trades) {
      const ts = effectiveTradeStatus(t)
      if (!t.bidders.length) lines.push([d.job.name, t.name, t.csiCode, ts].map(esc).join(','))
      for (const b of t.bidders) {
        lines.push(
          [d.job.name, t.name, t.csiCode, ts, b.companyName, b.contactName, b.email, b.phone, b.drawingsSentAt ?? '',
            b.followUpCount, b.lastFollowUpAt ?? '', b.willBidAt ?? '', b.priceReceivedAt ?? '', b.priceAmount ?? '', b.declinedAt ?? '',
            b.inclusions, b.exclusions, b.notes, ...d.addenda.map((a) => b.addendaSent[a.id] ?? '')]
            .map(esc).join(',')
        )
      }
    }
    return lines.join('\r\n')
  }

  // ---------- team users (team server only; not exposed through RPC) ----------
  userCount(): number {
    return Number(this.get('SELECT COUNT(*) AS c FROM users WHERE active = 1')?.c ?? 0)
  }

  listUsers(): TeamUser[] {
    return this.all('SELECT * FROM users ORDER BY username COLLATE NOCASE').map(toUser)
  }

  createUser(data: { username: string; displayName?: string; password: string; role?: 'admin' | 'member' }): TeamUser {
    const username = (data.username ?? '').trim()
    if (!/^[\w.@-]{2,60}$/.test(username)) throw new Error('Usernames are 2-60 letters, numbers, dots, dashes or @.')
    if ((data.password ?? '').length < 8) throw new Error('Passwords must be at least 8 characters.')
    if (this.get('SELECT id FROM users WHERE username = ?', username)) throw new Error('That username is taken.')
    const id = randomUUID()
    this.run(
      'INSERT INTO users(id, username, display_name, role, password_hash, active, created_at) VALUES(?,?,?,?,?,1,?)',
      id, username, data.displayName?.trim() || username, data.role === 'admin' ? 'admin' : 'member', hashPassword(data.password), now()
    )
    return toUser(this.get('SELECT * FROM users WHERE id = ?', id)!)
  }

  updateUser(id: string, data: { displayName?: string; role?: 'admin' | 'member'; active?: boolean; password?: string }): TeamUser {
    const u = this.get('SELECT * FROM users WHERE id = ?', id)
    if (!u) throw new Error('User not found')
    const demoting = (data.role && data.role !== 'admin') || data.active === false
    if (u.role === 'admin' && demoting) {
      const admins = Number(this.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", id)?.c ?? 0)
      if (admins === 0) throw new Error('Keep at least one active admin.')
    }
    if (data.password !== undefined && data.password.length < 8) throw new Error('Passwords must be at least 8 characters.')
    if (data.displayName !== undefined) this.run('UPDATE users SET display_name = ? WHERE id = ?', data.displayName.trim(), id)
    if (data.role) this.run('UPDATE users SET role = ? WHERE id = ?', data.role === 'admin' ? 'admin' : 'member', id)
    if (data.active !== undefined) {
      this.run('UPDATE users SET active = ? WHERE id = ?', data.active ? 1 : 0, id)
      if (!data.active) this.run('DELETE FROM sessions WHERE user_id = ?', id)
    }
    if (data.password !== undefined) {
      this.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(data.password), id)
      this.run('DELETE FROM sessions WHERE user_id = ?', id)
    }
    return toUser(this.get('SELECT * FROM users WHERE id = ?', id)!)
  }

  /** Checks a username/password and starts a session. Returns null when they don't match. */
  login(username: string, password: string): { token: string; user: TeamUser } | null {
    const u = this.get('SELECT * FROM users WHERE username = ? AND active = 1', (username ?? '').trim())
    if (!u || !checkPassword(password ?? '', u.password_hash)) return null
    const token = randomBytes(32).toString('base64url')
    const ts = now()
    this.run('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)',
      sha256(token), u.id, ts, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString())
    this.run('UPDATE users SET last_login_at = ? WHERE id = ?', ts, u.id)
    this.run('DELETE FROM sessions WHERE expires_at < ?', ts)
    return { token, user: toUser(this.get('SELECT * FROM users WHERE id = ?', u.id)!) }
  }

  sessionUser(token: string): TeamUser | null {
    if (!token) return null
    const r = this.get(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1',
      sha256(token), now()
    )
    return r ? toUser(r) : null
  }

  logout(token: string) {
    this.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token))
  }

  // ---------- change log ----------
  listAudit(jobId?: string | null, limit = 300): AuditEntry[] {
    const rows = jobId
      ? this.all('SELECT * FROM audit_log WHERE job_id = ? ORDER BY at DESC LIMIT ?', jobId, limit)
      : this.all('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?', limit)
    return rows.map((r) => ({ id: r.id, at: r.at, userName: r.user_name ?? '', method: r.method, summary: r.summary ?? '', jobId: r.job_id ?? null }))
  }

  private name(table: string, id: unknown, col = 'name'): string {
    return id ? String(this.get(`SELECT ${col} AS n FROM ${table} WHERE id = ?`, String(id))?.n ?? '') : ''
  }
  private jobOf(table: string, id: unknown): string | null {
    return id ? (this.get(`SELECT job_id AS j FROM ${table} WHERE id = ?`, String(id))?.j ?? null) : null
  }

  /** Plain-language description of a change, captured before it runs (so deletes can still name things). */
  private describe(method: string, a: any[]): { summary: string; jobId: string | null } {
    const fields = (o: any) => Object.keys(o ?? {}).join(', ')
    const bidder = (id: string) => {
      const r = this.get('SELECT b.company_name AS c, t.name AS t, b.job_id AS j FROM bidders b JOIN trades t ON t.id = b.trade_id WHERE b.id = ?', id)
      return { label: r ? `${r.c} (${r.t})` : 'company', jobId: (r?.j as string) ?? null }
    }
    const addNo = (id: unknown) => this.name('addenda', id, 'number')
    switch (method) {
      case 'createJob': return { summary: `Created job "${a[0]?.name ?? ''}"`, jobId: null }
      case 'updateJob': return { summary: `Edited job "${this.name('jobs', a[0])}": ${fields(a[1])}`, jobId: a[0] }
      case 'deleteJob': return { summary: `Deleted job "${this.name('jobs', a[0])}"`, jobId: null }
      case 'copyTrades': return { summary: `Copied trades from "${this.name('jobs', a[1])}"`, jobId: a[0] }
      case 'addTrade': return { summary: `Added trade "${a[1]?.name ?? ''}"`, jobId: a[0] }
      case 'addTrades': return { summary: `Added trades: ${(a[1] ?? []).map((t: any) => t.name).join(', ')}`, jobId: a[0] }
      case 'updateTrade': return { summary: `Edited trade "${this.name('trades', a[0])}": ${fields(a[1])}`, jobId: this.jobOf('trades', a[0]) }
      case 'deleteTrade': return { summary: `Deleted trade "${this.name('trades', a[0])}"`, jobId: this.jobOf('trades', a[0]) }
      case 'addBidder': return { summary: `Added ${a[1]?.companyName ?? 'company'} to ${this.name('trades', a[0])}`, jobId: this.jobOf('trades', a[0]) }
      case 'addBidders': return { summary: `Added ${(a[1] ?? []).map((b: any) => b.companyName).join(', ')} to ${this.name('trades', a[0])}`, jobId: this.jobOf('trades', a[0]) }
      case 'updateBidder': { const b = bidder(a[0]); return { summary: `Edited ${b.label}: ${fields(a[1])}`, jobId: b.jobId } }
      case 'deleteBidder': { const b = bidder(a[0]); return { summary: `Removed ${b.label}`, jobId: b.jobId } }
      case 'moveBidder': { const b = bidder(a[0]); return { summary: `Moved ${b.label} to ${this.name('trades', a[1])}`, jobId: b.jobId } }
      case 'bidderAction': {
        const b = bidder(a[0])
        const amt = a[2]?.amount != null ? ` $${Number(a[2].amount).toLocaleString('en-US')}` : ''
        return { summary: `${b.label}: ${ACTION_LABELS[a[1]] ?? a[1]}${amt}`, jobId: b.jobId }
      }
      case 'addNote': return { summary: `Note: ${String(a[1] ?? '').slice(0, 120)}`, jobId: a[0] }
      case 'saveCompany': return { summary: `${a[0]?.id ? 'Edited' : 'Added'} company "${a[0]?.name ?? this.name('companies', a[0]?.id)}" in the directory`, jobId: null }
      case 'deleteCompany': return { summary: `Deleted company "${this.name('companies', a[0])}" from the directory`, jobId: null }
      case 'importCompanies': return { summary: `Imported ${(a[0] ?? []).length} companies`, jobId: null }
      case 'saveTemplate': return { summary: `${a[0]?.id ? 'Edited' : 'Added'} template "${a[0]?.name ?? ''}"`, jobId: null }
      case 'deleteTemplate': return { summary: `Deleted template "${this.name('templates', a[0])}"`, jobId: null }
      case 'addAddendum': return { summary: `Added addendum ${a[1]?.number ?? ''} ${a[1]?.title ?? ''}`.trim(), jobId: a[0] }
      case 'updateAddendum': return { summary: `Edited addendum ${addNo(a[0])}: ${fields(a[1])}`, jobId: this.jobOf('addenda', a[0]) }
      case 'deleteAddendum': return { summary: `Deleted addendum ${addNo(a[0])}`, jobId: this.jobOf('addenda', a[0]) }
      case 'markAddendumSent': {
        const n = (a[1] ?? []).length
        return { summary: `Addendum ${addNo(a[0])} sent to ${n} compan${n === 1 ? 'y' : 'ies'}`, jobId: this.jobOf('addenda', a[0]) }
      }
      case 'setAddendumAck': {
        const b = bidder(a[1])
        return { summary: `${b.label}: ${a[2] === null ? 'cleared acknowledgment of' : 'acknowledged'} addendum ${addNo(a[0])}`, jobId: b.jobId }
      }
      case 'addFile': return { summary: `Attached file "${a[2] ?? ''}"${a[1] ? ' to ' + bidder(a[1]).label : ''}`, jobId: a[0] }
      case 'deleteFile': return { summary: `Deleted file "${this.name('files', a[0])}"`, jobId: this.jobOf('files', a[0]) }
      default: return { summary: method, jobId: null }
    }
  }

  /** Generic RPC dispatcher used by IPC and the team server. Every change is written to the change log. */
  call(method: string, args: any[], userName = ''): any {
    if (!(STORE_METHODS as readonly string[]).includes(method)) throw new Error('Unknown method: ' + method)
    const a = Array.isArray(args) ? [...args] : []
    const desc = READ_METHODS.has(method) ? null : this.describe(method, a)
    let result: any
    switch (method) {
      case 'createJob': result = this.createJob(a[0] ?? {}, userName); break
      case 'updateJob': result = this.updateJob(a[0], a[1] ?? {}, userName); break
      case 'bidderAction': result = this.bidderAction(a[0], a[1], a[2] ?? {}, userName); break
      case 'addNote': result = this.addNote(a[0], a[1], a[2] ?? null, userName); break
      case 'markAddendumSent': result = this.markAddendumSent(a[0], a[1] ?? [], a[2], userName); break
      case 'setAddendumAck': result = this.setAddendumAck(a[0], a[1], a[2] === undefined ? now() : a[2], userName); break
      case 'addFile': result = this.addFile(a[0], a[1] ?? null, a[2], a[3], a[4], userName); break
      case 'todaySummary': result = this.todaySummary(a[0] ?? 3, a[1]); break
      case 'listAudit': result = this.listAudit(a[0] ?? null, a[1] ?? 300); break
      default: result = (this as any)[method](...a)
    }
    if (desc) {
      const jobId = desc.jobId ?? (method === 'createJob' ? result?.id ?? null : null)
      this.run('INSERT INTO audit_log(id, at, user_name, method, summary, job_id) VALUES(?,?,?,?,?,?)',
        randomUUID(), now(), userName, method, desc.summary.slice(0, 500), jobId)
    }
    return result
  }
}