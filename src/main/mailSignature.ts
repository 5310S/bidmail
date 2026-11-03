// The Mac Mail signature an account sends with, so BidMail can show it while composing. Mail hands over a
// signature's pictures only inside an email, so it is taken from the newest sent email that carries it and kept in
// mail-signatures.json. Until such an email exists, the signature's text stands in (`exact` is false).
import path from 'node:path'
import { app } from 'electron'
import type { MailAccount, MailSignature } from '../shared/ipc'
import { escapeHtml } from '../shared/types'
import { appleMail, signatureFromSource } from './mail/appleMail'
import { readJson, writeJson } from './jsonFile'

type Cache = Record<string, { html: string; at: string }>
const file = () => path.join(app.getPath('userData'), 'mail-signatures.json')
const pending = new Map<string, Promise<MailSignature>>()

async function fetchSignature(account: MailAccount, name: string): Promise<MailSignature> {
  const { text, sources } = await appleMail.signatureSent(account.appleMailAccount ?? '', name)
  for (const source of sources) {
    const html = await signatureFromSource(source, text)
    if (html) {
      writeJson(file(), { ...readJson<Cache>(file(), {}), [name]: { html, at: new Date().toISOString() } })
      return { html, exact: true }
    }
  }
  return { html: escapeHtml(text.trim()).replace(/\r?\n/g, '<br>'), exact: false }
}

export async function mailSignatureHtml(account: MailAccount, refresh = false): Promise<MailSignature> {
  const name = account.appleMailSignature
  if (account.authType !== 'applemail' || !name) return { html: '', exact: true }
  const cached = readJson<Cache>(file(), {})[name]
  if (cached && !refresh) return { html: cached.html, exact: true }
  if (!pending.has(name)) pending.set(name, fetchSignature(account, name).finally(() => pending.delete(name)))
  return pending.get(name)!
}
