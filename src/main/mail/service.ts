// MailService: IMAP (reading, folders, flags, drafts) via imapflow, SMTP (sending) via nodemailer.
// Accounts connected through Mac Mail ('applemail') go through ./appleMail instead; each method branches on that.
import { app } from 'electron'
import { ImapFlow, FetchMessageObject, ListResponse, MailboxObject, SearchObject } from 'imapflow'
import nodemailer, { Transporter } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import Mail from 'nodemailer/lib/mailer'
import { simpleParser, ParsedMail, AddressObject, Attachment } from 'mailparser'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import {
  Address,
  AttachmentInfo,
  ComposeData,
  MailAccount,
  MailFolder,
  MessageDetail,
  MessageList,
  MessageSummary
} from '../../shared/ipc'
import { getAccount, listAccounts, saveAccount } from './accounts'
import { OAuthProvider, OAuthProviderId, refresh } from './oauth'
import { MailCache } from './cache'
import { buildReplyIcs, CalendarEvent, parseIcs, RsvpStatus } from '../../shared/ics'
import { htmlToText, wrapHtml } from './html'
import { appleMail, appleMailMessage } from './appleMail'

interface Conn {
  worker: ImapFlow | null
  watcher: ImapFlow | null
  watcherTimer: NodeJS.Timeout | null
  transport: Transporter | null
  transportToken?: string
  folders: MailFolder[]
}

interface CachedMessage {
  detail: MessageDetail
  attachments: Map<string, Attachment>
}

const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\All', '\\Flagged', '\\Junk', '\\Trash']

/** Password, or an OAuth access token for Microsoft/Google sign-in (XOAUTH2). */
export interface MailAuth {
  pass?: string
  accessToken?: string
}

function imapClient(account: MailAccount, secret: MailAuth, extra: Record<string, unknown> = {}) {
  const user = account.imap.user || account.email
  const c = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: secret.accessToken ? { user, accessToken: secret.accessToken } : { user, pass: secret.pass ?? '' },
    logger: false,
    tls: account.allowInvalidCerts ? { rejectUnauthorized: false } : undefined,
    ...extra
  } as any)
  c.on('error', () => {
    /* handled by reconnect logic; prevents unhandled 'error' crash */
  })
  return c
}

function smtpTransport(account: MailAccount, secret: MailAuth, pool = false) {
  const user = account.smtp.user || account.imap.user || account.email
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: secret.accessToken ? { type: 'OAuth2', user, accessToken: secret.accessToken } : { user, pass: secret.pass ?? '' },
    tls: account.allowInvalidCerts ? { rejectUnauthorized: false } : undefined,
    ...(pool ? { pool: true, maxConnections: 1, maxMessages: 100 } : {})
  } as any)
}

function addrList(a: AddressObject | AddressObject[] | undefined): Address[] {
  if (!a) return []
  const arr = Array.isArray(a) ? a : [a]
  return arr.flatMap((o) => o.value.map((v) => ({ name: v.name ?? '', address: v.address ?? '' })))
}

function envAddr(list: { name?: string; address?: string }[] | undefined): Address[] {
  return (list ?? []).map((v) => ({ name: v.name ?? '', address: v.address ?? '' }))
}

function hasAttachmentPart(node: any): boolean {
  if (!node) return false
  if (node.childNodes?.length) return node.childNodes.some(hasAttachmentPart)
  if (node.disposition === 'attachment') return true
  const name = node.dispositionParameters?.filename || node.parameters?.name
  return !!name && !String(node.type).startsWith('text/') && node.disposition !== 'inline'
}

function summaryFrom(m: FetchMessageObject): MessageSummary {
  const flags = m.flags ?? new Set<string>()
  return {
    uid: m.uid,
    subject: m.envelope?.subject ?? '(no subject)',
    from: envAddr(m.envelope?.from),
    to: envAddr(m.envelope?.to),
    cc: envAddr(m.envelope?.cc),
    date: validIso(m.envelope?.date ?? m.internalDate),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    draft: flags.has('\\Draft'),
    hasAttachments: hasAttachmentPart(m.bodyStructure),
    size: m.size ?? 0,
    messageId: m.envelope?.messageId ?? '',
    inReplyTo: m.envelope?.inReplyTo ?? ''
  }
}

function validIso(d: Date | string | undefined) {
  const v = new Date(d ?? Date.now())
  return isNaN(v.getTime()) ? new Date().toISOString() : v.toISOString()
}

function formatAddress(a: Address) {
  return a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address
}

function safeFileName(name: string) {
  return (name || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180)
}

export class MailService extends EventEmitter {
  private conns = new Map<string, Conn>()
  private cache = new Map<string, CachedMessage>()
  private disk: MailCache
  private prefetching = new Set<string>()
  private tokens = new Map<string, { accessToken: string; expiresAt: number }>()
  /** Mac Mail accounts: newest Inbox message id already announced, to spot new mail when polling. */
  private appleNewest = new Map<string, number>()
  /** Set by the app: resolves Microsoft/Google sign-in settings for token refresh. */
  oauthProvider: ((id: OAuthProviderId) => OAuthProvider) | null = null

  constructor(cacheRoot?: string) {
    super()
    this.disk = new MailCache(cacheRoot ?? path.join(app.getPath('userData'), 'mailcache'))
  }

  /** Deletes the offline copies of an account's mail (when the account is removed). */
  forgetAccount(accountId: string) {
    this.disk.removeAccount(accountId)
  }
  private conn(accountId: string): Conn {
    let c = this.conns.get(accountId)
    if (!c) {
      c = { worker: null, watcher: null, watcherTimer: null, transport: null, folders: [] }
      this.conns.set(accountId, c)
    }
    return c
  }

  private creds(accountId: string) {
    const a = getAccount(accountId)
    if (!a) throw new Error('Account not found')
    if (!a.password) {
      throw new Error(a.account.authType === 'oauth'
        ? `Sign in again for ${a.account.email} (Settings > Email Accounts).`
        : `No password saved for ${a.account.email}. Open Settings > Email Accounts.`)
    }
    return a
  }

  private accountOf(accountId: string): MailAccount {
    const a = getAccount(accountId)
    if (!a) throw new Error('Account not found')
    return a.account
  }

  /** The account's name in Mac Mail when it is connected through Mail, otherwise null. */
  private apple(accountId: string): string | null {
    const a = getAccount(accountId)?.account
    return a?.authType === 'applemail' ? (a.appleMailAccount ?? '') : null
  }

  /** Remembers the access token from a fresh sign-in so it is used before the first refresh. */
  rememberToken(accountId: string, accessToken: string, expiresAt: number) {
    this.tokens.set(accountId, { accessToken, expiresAt })
  }

  /** Password, or a valid OAuth access token (refreshed when it is about to expire). */
  private async auth(accountId: string): Promise<{ account: MailAccount; auth: MailAuth }> {
    const { account, password } = this.creds(accountId)
    if (account.authType !== 'oauth') return { account, auth: { pass: password } }
    const cached = this.tokens.get(accountId)
    if (cached && cached.expiresAt - 120000 > Date.now()) return { account, auth: { accessToken: cached.accessToken } }
    if (!this.oauthProvider) throw authError('Microsoft/Google sign-in is not set up on this computer.')
    let r
    try {
      r = await refresh(this.oauthProvider(account.oauthProvider ?? 'microsoft'), password)
    } catch (e: any) {
      // A revoked/expired sign-in must be fixed by the user; network trouble is handled like being offline.
      if (e?.code) throw authError(e.message)
      throw e
    }
    this.tokens.set(accountId, { accessToken: r.accessToken, expiresAt: r.expiresAt })
    if (r.refreshToken !== password) saveAccount({ account, password: r.refreshToken })
    return { account, auth: { accessToken: r.accessToken } }
  }

  private async worker(accountId: string): Promise<ImapFlow> {
    if (this.apple(accountId) !== null) throw new Error('This account is connected through Mac Mail; this action is not available for it.')
    const c = this.conn(accountId)
    if (c.worker && c.worker.usable) return c.worker
    const { account, auth } = await this.auth(accountId)
    const client = imapClient(account, auth)
    try {
      await client.connect()
    } catch (e: any) {
      const msg = friendlyError(e, account.imap.host)
      throw e?.authenticationFailed ? authError(msg) : new Error(msg)
    }
    client.on('close', () => {
      if (c.worker === client) c.worker = null
    })
    c.worker = client
    return client
  }

  /** Connects every account's INBOX watcher (IMAP IDLE) so new mail arrives immediately. */
  startWatchers() {
    for (const a of listAccounts()) this.startWatcher(a.id)
  }

  async startWatcher(accountId: string) {
    const c = this.conn(accountId)
    if (c.watcherTimer) clearTimeout(c.watcherTimer)
    c.watcherTimer = null
    if (this.apple(accountId) !== null) return this.pollAppleMail(accountId)
    if (c.watcher) {
      const old = c.watcher
      c.watcher = null
      old.removeAllListeners('close')
      old.logout().catch(() => old.close())
    }
    let creds
    try {
      creds = await this.auth(accountId)
    } catch {
      this.emit('status', { accountId, online: false })
      c.watcherTimer = setTimeout(() => this.startWatcher(accountId), 60000)
      return
    }
    // Start IDLE almost immediately so new mail shows up within seconds.
    const client = imapClient(creds.account, creds.auth, { autoIdleDelay: 1000 })
    c.watcher = client
    const retry = () => {
      if (c.watcher !== client) return
      c.watcher = null
      this.emit('status', { accountId, online: false })
      c.watcherTimer = setTimeout(() => this.startWatcher(accountId), 30000)
    }
    client.on('close', retry)
    try {
      await client.connect()
      await client.mailboxOpen('INBOX')
      this.emit('status', { accountId, online: true })
      client.on('exists', async (ev: { path: string; count: number; prevCount: number }) => {
        if (ev.count <= ev.prevCount) return
        const fresh: MessageSummary[] = []
        try {
          for await (const m of client.fetch(`${ev.prevCount + 1}:*`, { uid: true, envelope: true, flags: true })) {
            fresh.push(summaryFrom(m))
          }
        } catch {
          /* still notify without details */
        }
        this.emit('newMail', { accountId, path: 'INBOX', messages: fresh })
        this.prefetch(accountId, 'INBOX', fresh)
      })
    } catch {
      client.close()
    }
  }

  /** Mac Mail accounts: Mail fetches the mail; BidMail looks at the newest Inbox messages every 30 seconds. */
  private async pollAppleMail(accountId: string) {
    const c = this.conn(accountId)
    const name = this.apple(accountId)
    if (name === null) return
    try {
      const { messages } = await appleMail.list(name, 'INBOX', 0, 15)
      const seen = this.appleNewest.get(accountId)
      const fresh = seen === undefined ? [] : messages.filter((m) => m.uid > seen)
      this.appleNewest.set(accountId, Math.max(seen ?? 0, ...messages.map((m) => m.uid)))
      this.emit('status', { accountId, online: true })
      if (fresh.length) this.emit('newMail', { accountId, path: 'INBOX', messages: fresh })
    } catch {
      this.emit('status', { accountId, online: false })
    }
    if (this.conns.get(accountId) === c) c.watcherTimer = setTimeout(() => this.pollAppleMail(accountId), 30000)
  }

  async disconnect(accountId: string) {
    const c = this.conns.get(accountId)
    if (!c) return
    if (c.watcherTimer) clearTimeout(c.watcherTimer)
    const w = c.watcher
    c.watcher = null
    w?.removeAllListeners('close')
    await w?.logout().catch(() => w?.close())
    await c.worker?.logout().catch(() => c.worker?.close())
    c.transport?.close()
    this.conns.delete(accountId)
  }

  async disconnectAll() {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)))
  }

  async testAccount(account: MailAccount, secret: MailAuth): Promise<string> {
    if (account.authType === 'applemail') {
      const found = (await appleMail.accounts()).some((a) => a.name === account.appleMailAccount)
      if (!found) throw new Error(`Mail has no account named "${account.appleMailAccount}". Check Mail > Settings > Accounts.`)
      await appleMail.folders(account.appleMailAccount ?? '')
      return 'Connected through Mac Mail. Reading and sending both go through the Mail app.'
    }
    const client = imapClient(account, secret)
    try {
      await client.connect()
      await client.logout()
    } catch (e: any) {
      throw new Error('Incoming mail (IMAP) failed: ' + friendlyError(e, account.imap.host))
    }
    const t = smtpTransport(account, secret)
    try {
      await t.verify()
    } catch (e: any) {
      throw new Error('Outgoing mail (SMTP) failed: ' + friendlyError(e, account.smtp.host))
    } finally {
      t.close()
    }
    return 'Connected successfully. Incoming and outgoing mail both work.'
  }

  // ---------- folders ----------
  /** Folder list from the server; falls back to the saved copy when offline. */
  async listFolders(accountId: string): Promise<MailFolder[]> {
    try {
      const folders = await this.listFoldersLive(accountId)
      this.disk.saveFolders(accountId, folders)
      return folders
    } catch (e: any) {
      if (e?.authFailed) throw e // wrong password / expired sign-in: show it, don't hide it behind the offline copy
      const saved = this.disk.loadFolders(accountId)
      if (saved?.length) {
        this.conn(accountId).folders = saved
        this.emit('status', { accountId, online: false })
        return saved
      }
      throw e
    }
  }

  private async listFoldersLive(accountId: string): Promise<MailFolder[]> {
    const name = this.apple(accountId)
    if (name !== null) {
      const folders = await appleMail.folders(name)
      folders.sort((a, b) => {
        const ia = SPECIAL_ORDER.indexOf(a.specialUse)
        const ib = SPECIAL_ORDER.indexOf(b.specialUse)
        if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
        return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
      })
      this.conn(accountId).folders = folders
      return folders
    }
    const client = await this.worker(accountId)
    const list: ListResponse[] = await client.list({ statusQuery: { unseen: true, messages: true } })
    const folders: MailFolder[] = list
      .filter((f) => !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent'))
      .map((f) => ({
        path: f.path,
        name: f.path.toUpperCase() === 'INBOX' ? 'Inbox' : f.name,
        specialUse: f.path.toUpperCase() === 'INBOX' ? '\\Inbox' : (f.specialUse ?? ''),
        delimiter: f.delimiter ?? '/',
        unseen: f.status?.unseen ?? 0,
        total: f.status?.messages ?? 0,
        depth: 0
      }))
    // Depth relative to the shallowest visible parent, e.g. "[Gmail]/Sent Mail" is shown at top level.
    for (const f of folders) {
      const parts = f.path.split(f.delimiter)
      let depth = 0
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join(f.delimiter)
        if (folders.some((p) => p.path === parent)) depth++
      }
      f.depth = f.specialUse ? 0 : depth
    }
    folders.sort((a, b) => {
      const ia = SPECIAL_ORDER.indexOf(a.specialUse)
      const ib = SPECIAL_ORDER.indexOf(b.specialUse)
      if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
    })
    this.conn(accountId).folders = folders
    return folders
  }
  private async specialFolder(accountId: string, use: string, nameRe: RegExp, create?: string): Promise<string | null> {
    let folders = this.conn(accountId).folders
    if (!folders.length) folders = await this.listFolders(accountId)
    const f = folders.find((x) => x.specialUse === use) ?? folders.find((x) => nameRe.test(x.name))
    if (f) return f.path
    if (!create) return null
    await this.createFolder(accountId, create)
    return create
  }

  private async createFolder(accountId: string, name: string) {
    const apple = this.apple(accountId)
    if (apple !== null) await appleMail.createFolder(apple, name).catch(() => {})
    else await (await this.worker(accountId)).mailboxCreate(name).catch(() => {})
    await this.listFolders(accountId)
  }

  // ---------- messages ----------
  /** Newest messages first. Saves the first page (and downloads bodies) for offline reading. */
  async listMessages(accountId: string, folder: string, offset = 0, limit = 60): Promise<MessageList> {
    try {
      const { list, uidValidity } = await this.listMessagesLive(accountId, folder, offset, limit)
      if (offset === 0) {
        this.disk.saveList(accountId, folder, uidValidity, list)
        if (this.apple(accountId) === null) this.prefetch(accountId, folder, list.messages)
      }
      return list
    } catch (e: any) {
      if (e?.authFailed) throw e
      const saved = offset === 0 ? this.disk.loadList(accountId, folder) : null
      if (saved) return { ...saved.list, hasMore: false, offline: e?.message ?? String(e), savedAt: saved.savedAt }
      throw e
    }
  }

  private async listMessagesLive(accountId: string, folder: string, offset: number, limit: number) {
    const apple = this.apple(accountId)
    if (apple !== null) {
      const { total, messages } = await appleMail.list(apple, folder, offset, limit)
      return { uidValidity: 'mail', list: { messages, total, hasMore: offset + limit < total } as MessageList }
    }
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      // If the folder was already open, the server may be holding back new-message counts until the
      // next command. NOOP collects them so the list includes mail that arrived since.
      await client.noop()
      const box = client.mailbox as MailboxObject
      const uidValidity = String(box.uidValidity ?? '')
      const exists = box.exists ?? 0
      const end = exists - offset
      if (end < 1) return { uidValidity, list: { messages: [], total: exists, hasMore: false } as MessageList }
      const start = Math.max(1, end - limit + 1)
      const out: MessageSummary[] = []
      for await (const m of client.fetch(`${start}:${end}`, {
        uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true
      })) {
        out.push(summaryFrom(m))
      }
      out.sort((a, b) => b.uid - a.uid)
      return { uidValidity, list: { messages: out, total: exists, hasMore: start > 1 } as MessageList }
    } finally {
      lock.release()
    }
  }

  /**
   * Downloads the newest messages of a folder in the background so they can be read offline.
   * Uses BODY.PEEK (via imapflow), so nothing is marked as read. Small batches keep the
   * mailbox lock free for whatever the user clicks next.
   */
  private prefetch(accountId: string, folder: string, msgs: MessageSummary[]) {
    const key = accountId + '|' + folder
    if (this.prefetching.has(key)) return
    const todo = msgs
      .slice(0, 40)
      .filter((m) => m.size < 15 * 1024 * 1024 && !this.disk.hasSource(accountId, folder, m.uid))
      .map((m) => m.uid)
    if (!todo.length) return
    this.prefetching.add(key)
    ;(async () => {
      try {
        for (let i = 0; i < todo.length; i += 5) {
          const batch = todo.slice(i, i + 5).filter((uid) => !this.disk.hasSource(accountId, folder, uid))
          if (!batch.length) continue
          const client = await this.worker(accountId)
          const lock = await client.getMailboxLock(folder)
          try {
            for await (const m of client.fetch(batch.join(','), { uid: true, source: true }, { uid: true })) {
              if (m.source) this.disk.saveSource(accountId, folder, m.uid, m.source)
            }
          } finally {
            lock.release()
          }
        }
        this.disk.prune(accountId)
      } catch {
        /* offline or busy: try again next time */
      } finally {
        this.prefetching.delete(key)
      }
    })()
  }
  async search(accountId: string, folder: string, query: string): Promise<MessageList> {
    const apple = this.apple(accountId)
    if (apple !== null) {
      const found = (await appleMail.search(apple, folder, query.trim())).sort((a, b) => b.uid - a.uid)
      return { messages: found.slice(0, 150), total: found.length, hasMore: false }
    }
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      const q = query.trim()
      const uids = (await client.search({ or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }, { uid: true })) || []
      const pick = (uids as number[]).sort((a, b) => b - a).slice(0, 150)
      const out: MessageSummary[] = []
      if (pick.length) {
        for await (const m of client.fetch(pick.join(','), {
          uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true
        }, { uid: true })) {
          out.push(summaryFrom(m))
        }
      }
      out.sort((a, b) => b.uid - a.uid)
      return { messages: out, total: (uids as number[]).length, hasMore: false }
    } finally {
      lock.release()
    }
  }

  /**
   * Messages whose subject contains any of `subjects`, or that are from (received) / to or cc (sent) any of `people`
   * (addresses or company domains). Newest first, at most `limit`. Used to gather a job's emails.
   */
  async findMessages(accountId: string, folder: string, subjects: string[], people: string[], sent: boolean, limit = 300): Promise<MessageSummary[]> {
    if (!subjects.length && !people.length) return []
    const apple = this.apple(accountId)
    if (apple !== null) return (await appleMail.find(apple, folder, subjects, people, sent)).sort((a, b) => b.uid - a.uid).slice(0, limit)
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      const or: SearchObject[] = [
        ...subjects.map((subject) => ({ subject })),
        ...people.flatMap((p): SearchObject[] => (sent ? [{ to: p }, { cc: p }] : [{ from: p }]))
      ]
      const uids = ((await client.search(or.length === 1 ? or[0] : { or }, { uid: true })) || []) as number[]
      const pick = uids.sort((a, b) => b - a).slice(0, limit)
      const out: MessageSummary[] = []
      if (pick.length) {
        for await (const m of client.fetch(pick.join(','), { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true }, { uid: true })) {
          out.push(summaryFrom(m))
        }
      }
      return out.sort((a, b) => b.uid - a.uid)
    } finally {
      lock.release()
    }
  }

  private cacheKey(accountId: string, folder: string, uid: number) {
    return `${accountId}|${folder}|${uid}`
  }

  async getMessage(accountId: string, folder: string, uid: number, markSeen = true): Promise<MessageDetail> {
    const key = this.cacheKey(accountId, folder, uid)
    const hit = this.cache.get(key)
    if (hit) {
      if (markSeen && !hit.detail.seen) {
        hit.detail.seen = true
        this.setFlags(accountId, folder, [uid], { seen: true }).catch(() => {})
      }
      return hit.detail
    }

    let source = this.disk.loadSource(accountId, folder, uid)
    let flags = new Set<string>()
    let size = 0
    let fromCache = false
    if (source) {
      // Saved copy: open instantly (and offline). Flags come from the saved folder list.
      const summary = this.disk.loadList(accountId, folder)?.list.messages.find((m) => m.uid === uid)
      if (summary?.seen) flags.add('\\Seen')
      if (summary?.flagged) flags.add('\\Flagged')
      if (summary?.answered) flags.add('\\Answered')
      if (summary?.draft) flags.add('\\Draft')
      size = summary?.size ?? source.length
      fromCache = !this.conn(accountId).worker?.usable
      if (markSeen && !flags.has('\\Seen')) {
        flags.add('\\Seen')
        const update = this.setFlags(accountId, folder, [uid], { seen: true }).catch(() => {})
        if (!fromCache) await update // online: confirm with the server; offline: never wait on the network
      }
    } else if (this.apple(accountId) !== null) {
      const apple = this.apple(accountId) ?? ''
      source = await appleMail.source(apple, folder, uid)
      size = source.length
      const summary =
        this.disk.loadList(accountId, folder)?.list.messages.find((m) => m.uid === uid) ?? (await appleMail.summaries(apple, folder, [uid]))[0]
      if (summary?.seen) flags.add('\\Seen')
      if (summary?.flagged) flags.add('\\Flagged')
      if (summary?.answered) flags.add('\\Answered')
      if (markSeen && !flags.has('\\Seen')) {
        flags.add('\\Seen')
        await appleMail.setFlag(apple, folder, [uid], 'read', true).catch(() => {})
        this.patchSaved(accountId, folder, [uid], { seen: true })
      }
    } else {
      const client = await this.worker(accountId)
      const lock = await client.getMailboxLock(folder)
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true, size: true }, { uid: true })
        if (!msg || !msg.source) throw new Error('Message not found. It may have been moved or deleted.')
        source = msg.source
        flags = msg.flags ?? flags
        size = msg.size ?? msg.source.length
        if (markSeen && !flags.has('\\Seen')) {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => {})
          flags.add('\\Seen')
        }
      } finally {
        lock.release()
      }
      this.disk.saveSource(accountId, folder, uid, source)
      if (flags.has('\\Seen')) this.patchSaved(accountId, folder, [uid], { seen: true })
    }
    const parsed: ParsedMail = await simpleParser(source)

    const attachments = new Map<string, Attachment>()
    const infos: AttachmentInfo[] = []
    let invite: CalendarEvent | null = null
    let inviteAttachmentId: string | null = null
    let html = typeof parsed.html === 'string' ? parsed.html : ''
    parsed.attachments.forEach((att, i) => {
      const id = String(i)
      attachments.set(id, att)
      const cid = att.contentId?.replace(/^<|>$/g, '')
      const referenced = !!cid && html.includes('cid:' + cid)
      if (referenced) {
        const dataUri = `data:${att.contentType};base64,${att.content.toString('base64')}`
        html = html.split('cid:' + cid).join(dataUri)
      }
      const isCalendar = /^text\/calendar|^application\/ics/i.test(att.contentType) || /\.ics$/i.test(att.filename ?? '')
      if (isCalendar && !invite) {
        try {
          invite = parseIcs(att.content.toString('utf8'))
          if (invite) inviteAttachmentId = id
        } catch {
          /* not a readable calendar */
        }
      }
      // Inline images (already embedded in the HTML by mailparser, or just now) are not listed as files,
      // nor is the unnamed calendar part of an invite (it is shown as the invite card instead).
      const inlineImage = (referenced || att.related) && att.contentType.startsWith('image/') && att.contentDisposition !== 'attachment'
      const hiddenCalendar = isCalendar && !att.filename
      if (!inlineImage && !hiddenCalendar) {
        infos.push({
          id,
          filename: att.filename || `attachment-${i + 1}${guessExt(att.contentType)}`,
          contentType: att.contentType,
          size: att.size ?? att.content.length
        })
      }
    })
    const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : []
    const detail: MessageDetail = {
      key,
      uid,
      subject: parsed.subject ?? '(no subject)',
      from: addrList(parsed.from),
      to: addrList(parsed.to),
      cc: addrList(parsed.cc),
      bcc: addrList(parsed.bcc),
      replyTo: addrList(parsed.replyTo),
      date: (parsed.date ?? new Date()).toISOString(),
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      draft: flags.has('\\Draft'),
      hasAttachments: infos.length > 0,
      size,
      html,
      text: parsed.text ?? '',
      hasRemoteImages: /<img[^>]+src\s*=\s*["']?\s*https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html),
      attachments: infos,
      messageId: parsed.messageId ?? '',
      inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : '',
      references: refs,
      invite,
      inviteAttachmentId,
      fromCache
    }
    this.cache.set(key, { detail, attachments })
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value as string)
    return detail
  }

  /** Keeps the saved (offline) folder list in step with flag changes. */
  private patchSaved(accountId: string, folder: string, uids: number[], f: { seen?: boolean; flagged?: boolean; remove?: boolean }) {
    const set = new Set(uids)
    this.disk.patchList(accountId, folder, (l) => ({
      ...l,
      messages: f.remove
        ? l.messages.filter((m) => !set.has(m.uid))
        : l.messages.map((m) =>
            set.has(m.uid) ? { ...m, ...(f.seen !== undefined ? { seen: f.seen } : {}), ...(f.flagged !== undefined ? { flagged: f.flagged } : {}) } : m
          )
    }))
    if (f.remove) for (const uid of uids) this.disk.removeSource(accountId, folder, uid)
  }

  /** Sends an RSVP (Accept / Tentative / Decline) for a meeting invite back to its organizer. */
  async respondToInvite(accountId: string, key: string, status: RsvpStatus): Promise<boolean> {
    const detail = await this.detailFor(key)
    const ev = detail.invite
    if (!ev) throw new Error('This message has no meeting invite.')
    if (!ev.organizer?.email) throw new Error('This invite has no organizer to reply to.')
    if (this.apple(accountId) !== null) throw new Error('For accounts connected through Mac Mail, answer meeting invites in Mail or Calendar.')
    const account = this.accountOf(accountId)
    const verb = status === 'ACCEPTED' ? 'Accepted' : status === 'TENTATIVE' ? 'Tentative' : 'Declined'
    const me = account.displayName || account.email
    const domain = account.email.split('@')[1] || 'bidmail.local'
    const options: Mail.Options = {
      from: formatAddress({ name: account.displayName, address: account.email }),
      to: formatAddress({ name: ev.organizer.name, address: ev.organizer.email }),
      subject: `${verb}: ${ev.summary}`,
      text: `${me} has ${verb === 'Tentative' ? 'tentatively accepted' : verb.toLowerCase()} this invitation.`,
      icalEvent: { method: 'REPLY', content: buildReplyIcs(ev, { name: account.displayName, email: account.email }, status) },
      messageId: `<${randomUUID()}@${domain}>`
    }
    try {
      await (await this.transport(accountId)).sendMail(options)
    } catch (e: any) {
      this.conn(accountId).transport?.close()
      this.conn(accountId).transport = null
      throw new Error(friendlyError(e, account.smtp.host))
    }
    return true
  }

  private async detailFor(key: string): Promise<MessageDetail> {
    const hit = this.cache.get(key)
    if (hit) return hit.detail
    const [accountId, ...rest] = key.split('|')
    const uid = Number(rest.pop())
    return this.getMessage(accountId, rest.join('|'), uid, false)
  }
  private async attachment(key: string, id: string): Promise<Attachment> {
    let hit = this.cache.get(key)
    if (!hit) {
      const [accountId, ...rest] = key.split('|')
      const uid = Number(rest.pop())
      await this.getMessage(accountId, rest.join('|'), uid, false)
      hit = this.cache.get(key)
    }
    const att = hit?.attachments.get(id)
    if (!att) throw new Error('Attachment not found')
    return att
  }

  async attachmentName(key: string, id: string) {
    const hit = this.cache.get(key)
    const info = hit?.detail.attachments.find((a) => a.id === id)
    if (info) return info.filename
    const att = await this.attachment(key, id)
    return att.filename || 'attachment'
  }

  /** Writes an attachment to disk and returns the full path. */
  async writeAttachment(key: string, id: string, dir?: string, fileName?: string): Promise<string> {
    const att = await this.attachment(key, id)
    const name = safeFileName(fileName || (await this.attachmentName(key, id)))
    let target: string
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
      target = uniquePath(path.join(dir, name))
    } else {
      const tmp = path.join(app.getPath('temp'), 'BidMail', randomUUID().slice(0, 8))
      fs.mkdirSync(tmp, { recursive: true })
      target = path.join(tmp, name)
    }
    fs.writeFileSync(target, att.content)
    return target
  }

  async writeAttachmentTo(key: string, id: string, fullPath: string) {
    const att = await this.attachment(key, id)
    fs.writeFileSync(fullPath, att.content)
    return fullPath
  }

  async setFlags(accountId: string, folder: string, uids: number[], f: { seen?: boolean; flagged?: boolean }) {
    const apple = this.apple(accountId)
    if (apple !== null) {
      if (f.seen !== undefined) await appleMail.setFlag(apple, folder, uids, 'read', f.seen)
      if (f.flagged !== undefined) await appleMail.setFlag(apple, folder, uids, 'flagged', f.flagged)
      this.patchSaved(accountId, folder, uids, f)
      for (const uid of uids) {
        const hit = this.cache.get(this.cacheKey(accountId, folder, uid))
        if (hit) {
          if (f.seen !== undefined) hit.detail.seen = f.seen
          if (f.flagged !== undefined) hit.detail.flagged = f.flagged
        }
      }
      return true
    }
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      const range = uids.join(',')
      const add: string[] = []
      const remove: string[] = []
      if (f.seen !== undefined) (f.seen ? add : remove).push('\\Seen')
      if (f.flagged !== undefined) (f.flagged ? add : remove).push('\\Flagged')
      if (add.length) await client.messageFlagsAdd(range, add, { uid: true })
      if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true })
      this.patchSaved(accountId, folder, uids, f)
      for (const uid of uids) {
        const hit = this.cache.get(this.cacheKey(accountId, folder, uid))
        if (hit) {
          if (f.seen !== undefined) hit.detail.seen = f.seen
          if (f.flagged !== undefined) hit.detail.flagged = f.flagged
        }
      }
    } finally {
      lock.release()
    }
    return true
  }

  async move(accountId: string, folder: string, uids: number[], dest: string) {
    const apple = this.apple(accountId)
    if (apple !== null) await appleMail.move(apple, folder, uids, dest)
    else {
      const client = await this.worker(accountId)
      const lock = await client.getMailboxLock(folder)
      try {
        await client.messageMove(uids.join(','), dest, { uid: true })
      } finally {
        lock.release()
      }
    }
    for (const uid of uids) this.cache.delete(this.cacheKey(accountId, folder, uid))
    this.patchSaved(accountId, folder, uids, { remove: true })
    return true
  }

  async remove(accountId: string, folder: string, uids: number[]) {
    const trash = await this.specialFolder(accountId, '\\Trash', /^(trash|deleted( items| messages)?|bin)$/i)
    if (trash && trash !== folder) return this.move(accountId, folder, uids, trash)
    const apple = this.apple(accountId)
    if (apple !== null) await appleMail.move(apple, folder, uids, '')
    else {
      const client = await this.worker(accountId)
      const lock = await client.getMailboxLock(folder)
      try {
        await client.messageDelete(uids.join(','), { uid: true })
      } finally {
        lock.release()
      }
    }
    for (const uid of uids) this.cache.delete(this.cacheKey(accountId, folder, uid))
    this.patchSaved(accountId, folder, uids, { remove: true })
    return true
  }

  /** Moves one message and returns its UID in the destination folder (null if the server doesn't say). */
  async moveOne(accountId: string, folder: string, uid: number, dest: string): Promise<number | null> {
    const apple = this.apple(accountId)
    if (apple !== null) {
      // Mail gives a moved message a new id; find it again by its Message-ID (null until Mail has filed it).
      const [summary] = await appleMail.summaries(apple, folder, [uid])
      await appleMail.move(apple, folder, [uid], dest)
      this.cache.delete(this.cacheKey(accountId, folder, uid))
      this.patchSaved(accountId, folder, [uid], { remove: true })
      return summary?.messageId ? appleMail.findByMessageId(apple, dest, summary.messageId).catch(() => null) : null
    }
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    let newUid: number | null = null
    try {
      const r = await client.messageMove(String(uid), dest, { uid: true })
      newUid = (r ? r.uidMap?.get(uid) : undefined) ?? null
    } finally {
      lock.release()
    }
    this.cache.delete(this.cacheKey(accountId, folder, uid))
    this.patchSaved(accountId, folder, [uid], { remove: true })
    return newUid
  }

  /** Finds a message by its Message-ID header. */
  async findByMessageId(accountId: string, folder: string, messageId: string): Promise<number | null> {
    if (!messageId) return null
    const apple = this.apple(accountId)
    if (apple !== null) return appleMail.findByMessageId(apple, folder, messageId)
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      const uids = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) || []
      return (uids as number[]).length ? (uids as number[])[(uids as number[]).length - 1] : null
    } finally {
      lock.release()
    }
  }

  /** Returns the path of a folder with this name, creating it when missing. */
  async ensureFolder(accountId: string, name: string): Promise<string> {
    let folders = this.conn(accountId).folders
    if (!folders.length) folders = await this.listFolders(accountId)
    const found = folders.find((f) => f.name.toLowerCase() === name.toLowerCase() || f.path.toLowerCase() === name.toLowerCase())
    if (found) return found.path
    await this.createFolder(accountId, name)
    return name
  }

  /** Raw bytes of an attachment (to store a quote with a company). */
  async attachmentContent(key: string, id: string): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const att = await this.attachment(key, id)
    return { filename: await this.attachmentName(key, id), contentType: att.contentType, content: att.content }
  }

  async archive(accountId: string, folder: string, uids: number[]) {
    const dest =
      (await this.specialFolder(accountId, '\\Archive', /^archives?$/i)) ??
      (await this.specialFolder(accountId, '\\All', /^all mail$/i)) ??
      (await this.specialFolder(accountId, '\\Archive', /^archive$/i, 'Archive'))
    if (!dest || dest === folder) throw new Error('No archive folder available')
    return this.move(accountId, folder, uids, dest)
  }

  // ---------- composing / sending ----------
  private async buildOptions(data: ComposeData): Promise<Mail.Options> {
    const account = this.accountOf(data.accountId)
    const attachments: Mail.Attachment[] = []
    for (const a of data.attachments) {
      if (a.path) attachments.push({ filename: a.filename, path: a.path })
      else if (a.source) {
        const att = await this.attachment(a.source.key, a.source.id)
        attachments.push({ filename: a.filename, content: att.content, contentType: att.contentType })
      }
    }
    const domain = account.email.split('@')[1] || 'bidmail.local'
    return {
      from: formatAddress({ name: account.displayName, address: account.email }),
      to: data.to || undefined,
      cc: data.cc || undefined,
      bcc: data.bcc || undefined,
      subject: data.subject,
      html: wrapHtml(data.html),
      text: htmlToText(data.html),
      attachments,
      inReplyTo: data.inReplyTo || undefined,
      references: data.references?.length ? data.references : undefined,
      messageId: `<${randomUUID()}@${domain}>`
    }
  }

  private async raw(options: Mail.Options, keepBcc: boolean): Promise<Buffer> {
    const node: any = new MailComposer(options).compile()
    node.keepBcc = keepBcc
    return node.build()
  }

  /** Pooled SMTP connection; rebuilt when an OAuth access token is renewed. */
  private async transport(accountId: string): Promise<Transporter> {
    const c = this.conn(accountId)
    const { account, auth } = await this.auth(accountId)
    if (c.transport && auth.accessToken && c.transportToken !== auth.accessToken) {
      c.transport.close()
      c.transport = null
    }
    if (!c.transport) {
      c.transport = smtpTransport(account, auth, true)
      c.transportToken = auth.accessToken
    }
    return c.transport
  }

  async send(data: ComposeData): Promise<{ messageId: string }> {
    if (!data.to.trim() && !data.cc.trim() && !data.bcc.trim()) throw new Error('Add at least one recipient.')
    const account = this.accountOf(data.accountId)
    if (account.authType === 'applemail') return this.sendViaAppleMail(account, data)
    const options = await this.buildOptions(data)
    try {
      await (await this.transport(data.accountId)).sendMail(options)
    } catch (e: any) {
      this.conn(data.accountId).transport?.close()
      this.conn(data.accountId).transport = null
      throw new Error(friendlyError(e, account.smtp.host))
    }
    // Post-send housekeeping is best effort; the mail is already gone.
    try {
      if (account.saveSentCopy) {
        const sent = await this.specialFolder(data.accountId, '\\Sent', /^sent( items| messages| mail)?$/i, 'Sent')
        if (sent) {
          const client = await this.worker(data.accountId)
          await client.append(sent, await this.raw(options, true), ['\\Seen'])
        }
      }
      if (data.answered) await this.flagAnswered(data.accountId, data.answered.path, data.answered.uid)
      if (data.draft) await this.removeDraft(data.accountId, data.draft.path, data.draft.uid)
    } catch {
      /* ignore */
    }
    return { messageId: String(options.messageId) }
  }

  /**
   * Hands the message to Mac Mail to send (as plain text: Mail cannot be given formatted mail to send). The account's
   * Mail signature, when one is chosen, is added by Mail with its pictures, which makes the email formatted.
   * Mail files it in Sent itself. The Message-ID is Mail's own, so the returned one is only a placeholder.
   */
  private async sendViaAppleMail(account: MailAccount, data: ComposeData): Promise<{ messageId: string }> {
    const files: string[] = []
    for (const a of data.attachments) {
      if (a.path) files.push(a.path)
      else if (a.source) files.push(await this.writeAttachment(a.source.key, a.source.id, undefined, a.filename))
    }
    try {
      await appleMail.send({
        from: formatAddress({ name: account.displayName, address: account.email }),
        subject: data.subject,
        text: htmlToText(data.html),
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        signature: account.appleMailSignature ?? '',
        files
      })
    } catch (e: any) {
      throw new Error(appleMailMessage(e?.message ?? String(e)))
    }
    if (data.draft) await appleMail.move(account.appleMailAccount ?? '', data.draft.path, [data.draft.uid], '').catch(() => {})
    return { messageId: `<${randomUUID()}@${account.email.split('@')[1] || 'bidmail.local'}>` }
  }

  private async flagAnswered(accountId: string, folder: string, uid: number) {
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      await client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true })
    } finally {
      lock.release()
    }
  }

  private async removeDraft(accountId: string, folder: string, uid: number) {
    const client = await this.worker(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      await client.messageDelete(String(uid), { uid: true })
    } finally {
      lock.release()
    }
  }

  async saveDraft(data: ComposeData): Promise<{ path: string; uid: number } | null> {
    if (this.apple(data.accountId) !== null) throw new Error('Drafts cannot be saved for accounts connected through Mac Mail. Send the message, or keep this window open.')
    const drafts = await this.specialFolder(data.accountId, '\\Drafts', /^drafts?$/i, 'Drafts')
    if (!drafts) throw new Error('No Drafts folder')
    const options = await this.buildOptions(data)
    const client = await this.worker(data.accountId)
    const res = await client.append(drafts, await this.raw(options, true), ['\\Draft', '\\Seen'])
    if (data.draft) await this.removeDraft(data.accountId, data.draft.path, data.draft.uid).catch(() => {})
    return res && res.uid ? { path: drafts, uid: res.uid } : null
  }
}

function authError(message: string): Error {
  const e = new Error(message) as Error & { authFailed: boolean }
  e.authFailed = true
  return e
}

function guessExt(type: string) {
  const map: Record<string, string> = {
    'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'text/plain': '.txt', 'text/calendar': '.ics', 'message/rfc822': '.eml'
  }
  return map[type] ?? ''
}

function uniquePath(p: string) {
  if (!fs.existsSync(p)) return p
  const ext = path.extname(p)
  const base = p.slice(0, p.length - ext.length)
  for (let i = 2; ; i++) {
    const c = `${base} (${i})${ext}`
    if (!fs.existsSync(c)) return c
  }
}

export function friendlyError(e: any, host: string): string {
  const code = e?.code || e?.cause?.code
  const msg = String(e?.responseText || e?.response || e?.message || e)
  if (e?.authenticationFailed || /auth|credentials|password|login/i.test(msg) || code === 'EAUTH')
    return 'Sign-in was rejected. Outlook, Hotmail and Microsoft 365 no longer accept passwords from email apps: add the account with "Sign in with Microsoft" instead. Gmail, Yahoo and iCloud need an "app password" (not your normal password), or use "Sign in with Google" for Gmail.'
  if (code === 'ENOTFOUND') return `Server "${host}" was not found. Check the server name.`
  if (code === 'ECONNREFUSED') return `Server "${host}" refused the connection. Check the port and security setting.`
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION') return `Could not connect to "${host}". Check the port, security setting, and your internet connection.`
  if (/certificate|self.signed/i.test(msg)) return 'The server security certificate is not trusted. If this is your company server, enable "Allow untrusted certificates".'
  return msg
}