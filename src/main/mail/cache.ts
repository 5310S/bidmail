// On-disk mail cache so folders and recently received messages can be read without an internet connection.
// Layout: <root>/<accountId>/folders.json, <folderKey>.list.json, <folderKey>/<uid>.eml
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { MailFolder, MessageList } from '../../shared/ipc'

const MAX_MESSAGES_PER_ACCOUNT = 800

export class MailCache {
  constructor(private root: string) {}

  private acct(accountId: string) {
    const d = path.join(this.root, accountId.replace(/[^\w-]/g, '_'))
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  private key(folder: string) {
    return createHash('sha1').update(folder).digest('hex').slice(0, 16)
  }

  private read<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T
    } catch {
      return null
    }
  }

  private write(file: string, data: unknown) {
    try {
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, file)
    } catch {
      /* cache writes are best effort */
    }
  }

  saveFolders(accountId: string, folders: MailFolder[]) {
    this.write(path.join(this.acct(accountId), 'folders.json'), folders)
  }

  loadFolders(accountId: string): MailFolder[] | null {
    return this.read(path.join(this.acct(accountId), 'folders.json'))
  }

  /** Saves the newest page of a folder. A changed UIDVALIDITY means the server renumbered it: drop old copies. */
  saveList(accountId: string, folder: string, uidValidity: string, list: MessageList) {
    const file = path.join(this.acct(accountId), this.key(folder) + '.list.json')
    const prev = this.read<{ uidValidity: string }>(file)
    if (prev && prev.uidValidity !== uidValidity) this.purgeFolder(accountId, folder)
    this.write(file, { uidValidity, savedAt: new Date().toISOString(), list: { ...list, offline: undefined } })
  }

  loadList(accountId: string, folder: string): { savedAt: string; list: MessageList } | null {
    return this.read(path.join(this.acct(accountId), this.key(folder) + '.list.json'))
  }

  /** Updates flags/removals in the saved list so offline views stay accurate. */
  patchList(accountId: string, folder: string, fn: (l: MessageList) => MessageList) {
    const file = path.join(this.acct(accountId), this.key(folder) + '.list.json')
    const cur = this.read<{ uidValidity: string; savedAt: string; list: MessageList }>(file)
    if (cur) this.write(file, { ...cur, list: fn(cur.list) })
  }

  private sourcePath(accountId: string, folder: string, uid: number) {
    return path.join(this.acct(accountId), this.key(folder), `${uid}.eml`)
  }

  hasSource(accountId: string, folder: string, uid: number) {
    return fs.existsSync(this.sourcePath(accountId, folder, uid))
  }

  saveSource(accountId: string, folder: string, uid: number, source: Buffer) {
    try {
      const p = this.sourcePath(accountId, folder, uid)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, source)
    } catch {
      /* best effort */
    }
  }

  loadSource(accountId: string, folder: string, uid: number): Buffer | null {
    try {
      return fs.readFileSync(this.sourcePath(accountId, folder, uid))
    } catch {
      return null
    }
  }

  removeSource(accountId: string, folder: string, uid: number) {
    fs.rmSync(this.sourcePath(accountId, folder, uid), { force: true })
  }

  purgeFolder(accountId: string, folder: string) {
    fs.rmSync(path.join(this.acct(accountId), this.key(folder)), { recursive: true, force: true })
  }

  removeAccount(accountId: string) {
    fs.rmSync(this.acct(accountId), { recursive: true, force: true })
  }

  /** Keeps the cache bounded: deletes the least recently saved messages beyond the limit. */
  prune(accountId: string, max = MAX_MESSAGES_PER_ACCOUNT) {
    try {
      const dir = this.acct(accountId)
      const files: { p: string; t: number }[] = []
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue
        for (const f of fs.readdirSync(path.join(dir, sub.name))) {
          const p = path.join(dir, sub.name, f)
          files.push({ p, t: fs.statSync(p).mtimeMs })
        }
      }
      if (files.length <= max) return
      files.sort((a, b) => a.t - b.t)
      for (const f of files.slice(0, files.length - max)) fs.rmSync(f.p, { force: true })
    } catch {
      /* ignore */
    }
  }
}