import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { AppSettings } from '../shared/ipc'
import { readJson, writeJson } from './jsonFile'
import { decryptSecret, encryptSecret } from './secrets'
import { DEFAULT_OAUTH } from './mail/oauth'
import { DEFAULT_REMINDERS } from './reminders'
import { LEOPARD_DEFAULT_URL } from './leopard'

const file = () => path.join(app.getPath('userData'), 'settings.json')

const DEFAULTS: AppSettings = {
  userName: '',
  companyName: '',
  team: { mode: 'local', url: '', key: '', port: 4780, https: true, username: '', token: '', certPem: '' },
  reading: { fontSize: 16, loadRemoteImages: false, simpleView: false, theme: 'light', conversations: true },
  trustedImageSenders: [],
  sendDelayMs: 1500,
  notifications: true,
  oauth: DEFAULT_OAUTH,
  reminders: DEFAULT_REMINDERS,
  updates: { url: '', enabled: true },
  leopard: { url: LEOPARD_DEFAULT_URL, email: '', cookie: '' }
}

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  const raw = readJson<any>(file(), {})
  const s: AppSettings = {
    ...DEFAULTS,
    ...raw,
    // Settings saved by 1.0.0 have no https flag: keep plain HTTP for those so existing teammates stay connected.
    team: { ...DEFAULTS.team, ...(raw.team ? { https: false } : {}), ...(raw.team ?? {}) },
    reading: { ...DEFAULTS.reading, ...(raw.reading ?? {}) },
    oauth: { ...DEFAULTS.oauth, ...(raw.oauth ?? {}) },
    reminders: { ...DEFAULTS.reminders, ...(raw.reminders ?? {}) },
    updates: { ...DEFAULTS.updates, ...(raw.updates ?? {}) },
    leopard: { ...DEFAULTS.leopard, ...(raw.leopard ?? {}) }
  }
  s.team.key = decryptSecret(s.team.key)
  s.team.token = decryptSecret(s.team.token)
  s.oauth.googleClientSecret = decryptSecret(s.oauth.googleClientSecret)
  s.leopard.cookie = decryptSecret(s.leopard.cookie)
  if (!s.userName) s.userName = os.userInfo().username
  cache = s
  return s
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const cur = getSettings()
  const next: AppSettings = {
    ...cur,
    ...patch,
    team: { ...cur.team, ...(patch.team ?? {}) },
    reading: { ...cur.reading, ...(patch.reading ?? {}) },
    oauth: { ...cur.oauth, ...(patch.oauth ?? {}) },
    reminders: { ...cur.reminders, ...(patch.reminders ?? {}) },
    updates: { ...cur.updates, ...(patch.updates ?? {}) },
    leopard: { ...cur.leopard, ...(patch.leopard ?? {}) }
  }
  if (next.leopard.cookie === '(signed in)') next.leopard.cookie = cur.leopard.cookie
  cache = next
  writeJson(file(), {
    ...next,
    team: { ...next.team, key: encryptSecret(next.team.key), token: encryptSecret(next.team.token) },
    oauth: { ...next.oauth, googleClientSecret: encryptSecret(next.oauth.googleClientSecret) },
    leopard: { ...next.leopard, cookie: encryptSecret(next.leopard.cookie) }
  })
  return next
}

/** Settings as shown to the screens: the session token never leaves the main process. */
export function publicSettings(): AppSettings {
  const s = getSettings()
  return { ...s, team: { ...s.team, token: s.team.token ? '(signed in)' : '' }, leopard: { ...s.leopard, cookie: s.leopard.cookie ? '(signed in)' : '' } }
}