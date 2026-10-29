// Snooze: moves a message to a "Snoozed" folder on the mail server and brings it back to the Inbox
// (as unread, with a notification) at the chosen time. The schedule is saved on this computer.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readJson, writeJson } from '../jsonFile'
import type { MailService } from './service'

export interface Snooze {
  id: string
  accountId: string
  messageId: string
  subject: string
  from: string
  until: string
  snoozedFolder: string
  snoozedUid: number | null
  returnFolder: string
  createdAt: string
}

export const SNOOZE_FOLDER = 'Snoozed'

export class SnoozeService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private mail: MailService, private file: string) {
    super()
  }

  list(): Snooze[] {
    return readJson<Snooze[]>(this.file, []).sort((a, b) => a.until.localeCompare(b.until))
  }

  private save(list: Snooze[]) {
    writeJson(this.file, list)
  }

  async snooze(accountId: string, folder: string, uid: number, until: string): Promise<Snooze> {
    if (new Date(until).getTime() <= Date.now()) throw new Error('Pick a time in the future.')
    const msg = await this.mail.getMessage(accountId, folder, uid, false)
    const dest = await this.mail.ensureFolder(accountId, SNOOZE_FOLDER)
    if (dest === folder) throw new Error('This message is already snoozed.')
    const newUid = await this.mail.moveOne(accountId, folder, uid, dest)
    const s: Snooze = {
      id: randomUUID(), accountId, messageId: msg.messageId, subject: msg.subject,
      from: msg.from[0]?.name || msg.from[0]?.address || '', until, snoozedFolder: dest, snoozedUid: newUid,
      returnFolder: folder === 'INBOX' || !folder ? 'INBOX' : folder, createdAt: new Date().toISOString()
    }
    this.save([...this.list(), s])
    return s
  }

  /** Brings a snoozed message back now (or when its time comes). */
  async wake(id: string): Promise<boolean> {
    const s = this.list().find((x) => x.id === id)
    if (!s) return false
    let uid = s.messageId ? await this.mail.findByMessageId(s.accountId, s.snoozedFolder, s.messageId).catch(() => null) : null
    if (uid == null) uid = s.snoozedUid
    if (uid != null) {
      const back = await this.mail.moveOne(s.accountId, s.snoozedFolder, uid, s.returnFolder)
      const backUid = back ?? (s.messageId ? await this.mail.findByMessageId(s.accountId, s.returnFolder, s.messageId).catch(() => null) : null)
      if (backUid != null) await this.mail.setFlags(s.accountId, s.returnFolder, [backUid], { seen: false }).catch(() => {})
      this.emit('woke', { snooze: s, uid: backUid })
    }
    // Remove it either way: if the message was moved or deleted on another device, there is nothing to bring back.
    this.save(this.list().filter((x) => x.id !== id))
    return true
  }

  cancel(id: string) {
    return this.wake(id)
  }

  start() {
    this.timer = setInterval(() => this.tick(), 60000)
    setTimeout(() => this.tick(), 5000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const due = this.list().filter((s) => new Date(s.until).getTime() <= Date.now())
      for (const s of due) await this.wake(s.id).catch(() => {}) // offline: try again next minute
    } finally {
      this.busy = false
    }
  }
}