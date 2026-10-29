import { app } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AccountSaveInput, MailAccount } from '../../shared/ipc'
import { readJson, writeJson } from '../jsonFile'
import { decryptSecret, encryptSecret } from '../secrets'

interface StoredAccount extends MailAccount {
  password: string // encrypted
}

const file = () => path.join(app.getPath('userData'), 'accounts.json')

function load(): StoredAccount[] {
  return readJson<StoredAccount[]>(file(), [])
}

export function listAccounts(): MailAccount[] {
  return load().map(({ password, ...a }) => ({ ...a, hasPassword: !!password }))
}

export function getAccount(id: string): { account: MailAccount; password: string } | null {
  const a = load().find((x) => x.id === id)
  if (!a) return null
  const { password, ...account } = a
  return { account, password: decryptSecret(password) }
}

export function saveAccount(input: AccountSaveInput): MailAccount {
  const list = load()
  const acc = { ...input.account }
  delete acc.hasPassword
  if (!acc.id) acc.id = randomUUID()
  const idx = list.findIndex((x) => x.id === acc.id)
  const password = input.password !== undefined ? encryptSecret(input.password) : idx > -1 ? list[idx].password : ''
  const stored: StoredAccount = { ...acc, password }
  if (idx > -1) list[idx] = stored
  else list.push(stored)
  writeJson(file(), list)
  return { ...acc, hasPassword: !!password }
}

export function deleteAccount(id: string) {
  writeJson(file(), load().filter((x) => x.id !== id))
}