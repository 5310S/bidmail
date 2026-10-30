import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { BidBackend, normalizeUrl } from './bidBackend'
import { MailService } from './mail/service'
import { BulkSender } from './bulk'
import { deleteAccount, getAccount, listAccounts, saveAccount } from './mail/accounts'
import { getSettings, publicSettings, saveSettings } from './settings'
import { htmlToPdf, printHtml } from './print'
import { providerFor, signIn, OAuthProviderId } from './mail/oauth'
import { SnoozeService } from './mail/snooze'
import { RulesRunner } from './mail/rulesRunner'
import { startReminders } from './reminders'
import { Updater } from './updater'
import { publishInstaller } from './updatesFeed'
import { fetchCertificate } from './net'
import { LeopardService } from './leopardService'
import { readXlsx } from './xlsx'
import { csvRows, parseVendorList } from '../shared/vendorList'
import { AccountSaveInput, AppSettings, ComposeData, MailAccount, MessageSummary, PickedFile, TeamSettings } from '../shared/ipc'
import type { MailRule } from '../shared/rules'

// Optional data folder override (portable installs, automated tests).
if (process.env.BIDMAIL_DATA_DIR) app.setPath('userData', path.resolve(process.env.BIDMAIL_DATA_DIR))

let win: BrowserWindow | null = null

const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function focusWindow() {
  if (!win || win.isDestroyed()) createWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
}

function notify(title: string, body: string, onClick?: () => void) {
  if (!getSettings().notifications || !Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    focusWindow()
    onClick?.()
  })
  n.show()
}

const backend = new BidBackend(
  () => getSettings().userName,
  (rev) => send('bid:changed', rev),
  (status) => send('bid:status', status)
)
const mail = new MailService()
mail.oauthProvider = (id) => providerFor(id, getSettings().oauth)
const bulk = new BulkSender(mail, backend, (p) => send('bulk:progress', p))
const dataFile = (name: string) => path.join(app.getPath('userData'), name)
let snoozer: SnoozeService
let rules: RulesRunner
const updater = new Updater((s) => send('update:status', s))
const leopard = new LeopardService(backend)

/** The team server hosts updates for its teammates unless a different folder is set. */
function configureUpdates() {
  const s = getSettings()
  if (!s.updates.enabled) return updater.configure('')
  const feed = s.updates.url.trim() || (s.team.mode === 'remote' && s.team.url ? normalizeUrl(s.team.url) + '/updates' : '')
  updater.configure(feed, s.team.mode === 'remote' && feed.startsWith(normalizeUrl(s.team.url)) ? s.team.certPem || undefined : undefined)
}

mail.on('newMail', async (ev: { accountId: string; path: string; messages: MessageSummary[] }) => {
  // Rules first, so mail that gets filed away or marked read doesn't pop up a notification.
  const plan = await rules.apply(ev.accountId, ev.path, ev.messages).catch(() => [])
  const silent = new Set(plan.filter((p) => p.silent || p.markRead).map((p) => p.uid))
  send('mail:new', ev)
  const shown = ev.messages.filter((m) => !silent.has(m.uid))
  if (!shown.length) return
  const first = shown[0]
  const from = first?.from?.[0]?.name || first?.from?.[0]?.address || 'New message'
  notify(shown.length > 1 ? `${shown.length} new messages` : from, first?.subject ?? '', () =>
    send('mail:open', { accountId: ev.accountId, path: ev.path, uid: first.uid })
  )
})
mail.on('status', (s) => send('mail:accountStatus', s))

/** Registers an IPC handler whose errors reach the renderer as clean messages. */
function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, result: await fn(...args) }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
  })
}

async function applyTeam(patch: Partial<TeamSettings>) {
  const cur = getSettings().team
  const team = { ...cur, ...patch }
  if (team.token === '(signed in)') team.token = cur.token
  saveSettings({ team })
  await backend.configure(getSettings().team)
  configureUpdates()
  return backend.getStatus()
}

function registerIpc() {
  // bid tracking
  handle('bid:call', (method: string, args: any[]) => backend.call(method, args))
  handle('bid:status', () => backend.getStatus())

  // Leopard (takeoff software)
  handle('leopard:status', () => leopard.status())
  handle('leopard:login', (url: string, email: string, password: string) => leopard.login(url, email, password))
  handle('leopard:logout', () => leopard.logout())
  handle('leopard:projects', () => leopard.projects())
  handle('leopard:link', (jobId: string, projectId: string | null) => leopard.link(jobId, projectId))
  handle('leopard:import', (jobId: string) => leopard.importTakeoff(jobId))
  handle('leopard:check', (jobId: string) => leopard.check(jobId))
  handle('leopard:open', (projectId?: string, itemId?: string) => shell.openExternal(leopard.openUrl(projectId, itemId)))

  // the vendor list: an Excel sheet of subcontractors by trade, imported into Companies
  handle('vendors:import', async (filePath?: string) => {
    let p = filePath
    if (!p) {
      const r = await dialog.showOpenDialog(win!, { title: 'Choose your vendor list', properties: ['openFile'], filters: [{ name: 'Vendor list', extensions: ['xlsx', 'csv'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      p = r.filePaths[0]
    }
    const ext = path.extname(p).toLowerCase()
    if (ext === '.xls') throw new Error('This is an old-style Excel file (.xls). Open it in Excel and save it as .xlsx, then import it.')
    let result: ReturnType<typeof parseVendorList> | null = null
    let lastError = ''
    const sheets = ext === '.csv' ? [{ name: 'CSV', rows: csvRows(fs.readFileSync(p, 'utf8')) }] : readXlsx(fs.readFileSync(p))
    for (const s of sheets) {
      try {
        const r = parseVendorList(s.rows)
        if (!result || r.companies.length > result.companies.length) result = r
      } catch (e: any) {
        lastError = e.message
      }
    }
    if (!result || !result.companies.length) throw new Error(lastError || 'No companies found in that file.')
    const res = await backend.call('importCompanies', [result.companies])
    const trades = new Set(result.companies.flatMap((c) => (c.trades ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)))
    return { file: path.basename(p), title: result.title, added: res.added, updated: res.updated, skipped: result.skipped, total: result.companies.length, trades: trades.size }
  })  // settings
  handle('settings:get', () => publicSettings())
  handle('settings:save', (patch: Partial<AppSettings>) => {
    const { team: _ignored, ...rest } = patch // team changes go through the team:* handlers
    const s = saveSettings(rest)
    if (patch.reading?.theme) nativeTheme.themeSource = s.reading.theme
    if (patch.updates) configureUpdates()
    return publicSettings()
  })

  // team sharing
  handle('team:apply', (team: Partial<TeamSettings>) => applyTeam(team))
  handle('team:cert', async (url: string) => {
    const u = normalizeUrl(url)
    if (!u.startsWith('https:')) return null
    return fetchCertificate(u)
  })
  handle('team:test', async (url: string, certPem?: string) => {
    const h = await BidBackend.health(url, certPem)
    return h.needsSetup ? 'Connected. This server has no accounts yet: create the first admin with its setup key.' : 'Connected to the team server.'
  })
  handle('team:health', (url: string, certPem?: string) => BidBackend.health(url, certPem))
  handle('team:login', async (url: string, username: string, password: string, certPem?: string) => {
    const r = await BidBackend.login(url, username, password, certPem)
    return applyTeam({ mode: 'remote', url: normalizeUrl(url), username: r.user.username, token: r.token, certPem: certPem ?? '', key: '' })
  })
  handle('team:setup', async (url: string, setupKey: string, username: string, password: string, displayName: string, certPem?: string) => {
    const r = await BidBackend.setup(url, setupKey, username, password, displayName, certPem)
    return applyTeam({ mode: 'remote', url: normalizeUrl(url), username: r.user.username, token: r.token, certPem: certPem ?? '', key: '' })
  })
  handle('team:logout', async () => {
    await backend.logout()
    return applyTeam({ token: '' })
  })
  handle('team:password', async (current: string, next: string) => {
    const token = await backend.changePassword(current, next)
    return applyTeam({ token })
  })
  handle('team:users', () => backend.listUsers())
  handle('team:createUser', (u) => backend.createUser(u))
  handle('team:updateUser', (id: string, patch) => backend.updateUser(id, patch))

  // accounts
  handle('accounts:list', () => listAccounts())
  handle('accounts:save', async (input: AccountSaveInput) => {
    const a = saveAccount(input)
    await mail.disconnect(a.id)
    mail.startWatcher(a.id)
    return a
  })
  handle('accounts:delete', async (id: string) => {
    await mail.disconnect(id)
    mail.forgetAccount(id)
    deleteAccount(id)
    return true
  })
  handle('accounts:test', async (account: MailAccount, password?: string) => {
    if (account.authType === 'oauth' && account.id) {
      // Signed-in accounts test with a fresh access token.
      await mail.disconnect(account.id)
      await mail.listFolders(account.id)
      return 'Connected successfully.'
    }
    const pw = password ?? (account.id ? getAccount(account.id)?.password : '') ?? ''
    return mail.testAccount(account, { pass: pw })
  })
  /** Sign in with Microsoft / Google in the browser, then add (or update) the account. */
  handle('accounts:oauth', async (provider: OAuthProviderId, existingId?: string) => {
    const p = providerFor(provider, getSettings().oauth)
    const r = await signIn(p, (url) => shell.openExternal(url))
    const existing = existingId ? getAccount(existingId)?.account : listAccounts().find((a) => a.email.toLowerCase() === r.email)
    const account: MailAccount = {
      id: existing?.id ?? '',
      displayName: existing?.displayName || r.name || getSettings().userName,
      email: r.email,
      imap: { ...p.imap, user: r.email },
      smtp: { ...p.smtp, user: r.email },
      signature: existing?.signature ?? '',
      color: existing?.color ?? '#2f6fdb',
      saveSentCopy: false,
      allowInvalidCerts: false,
      authType: 'oauth',
      oauthProvider: provider
    }
    await mail.testAccount(account, { accessToken: r.accessToken })
    const saved = saveAccount({ account, password: r.refreshToken })
    mail.rememberToken(saved.id, r.accessToken, r.expiresAt)
    await mail.disconnect(saved.id)
    mail.startWatcher(saved.id)
    return saved
  })
  // mail
  handle('mail:folders', (accountId: string) => mail.listFolders(accountId))
  handle('mail:list', (accountId: string, folder: string, offset?: number, limit?: number) =>
    mail.listMessages(accountId, folder, offset, limit)
  )
  handle('mail:search', (accountId: string, folder: string, q: string) => mail.search(accountId, folder, q))
  handle('mail:get', (accountId: string, folder: string, uid: number) => mail.getMessage(accountId, folder, uid))
  handle('mail:flags', (accountId: string, folder: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) =>
    mail.setFlags(accountId, folder, uids, flags)
  )
  handle('mail:move', (accountId: string, folder: string, uids: number[], dest: string) => mail.move(accountId, folder, uids, dest))
  handle('mail:delete', (accountId: string, folder: string, uids: number[]) => mail.remove(accountId, folder, uids))
  handle('mail:archive', (accountId: string, folder: string, uids: number[]) => mail.archive(accountId, folder, uids))
  handle('mail:send', (data: ComposeData) => mail.send(data))
  handle('mail:draft', (data: ComposeData) => mail.saveDraft(data))
  handle('mail:rsvp', (accountId: string, key: string, status: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED') =>
    mail.respondToInvite(accountId, key, status)
  )

  // snooze
  handle('snooze:add', (accountId: string, folder: string, uid: number, until: string) => snoozer.snooze(accountId, folder, uid, until))
  handle('snooze:list', () => snoozer.list())
  handle('snooze:wake', (id: string) => snoozer.wake(id))

  // rules
  handle('rules:list', () => rules.list())
  handle('rules:save', (list: MailRule[]) => rules.save(list))
  handle('rules:run', async (accountId?: string) => {
    let n = 0
    for (const a of listAccounts()) if (!accountId || a.id === accountId) n += await rules.runOnInbox(a.id)
    return n
  })

  // attachments
  handle('att:open', async (key: string, id: string) => {
    const p = await mail.writeAttachment(key, id)
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
    return p
  })
  handle('att:save', async (key: string, id: string) => {
    const name = await mail.attachmentName(key, id)
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), name) })
    if (r.canceled || !r.filePath) return null
    return mail.writeAttachmentTo(key, id, r.filePath)
  })
  handle('att:saveAll', async (key: string, ids: string[], dir?: string) => {
    let target = dir
    if (!target) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('downloads') })
      if (r.canceled || !r.filePaths[0]) return null
      target = r.filePaths[0]
    }
    const out: string[] = []
    for (const id of ids) out.push(await mail.writeAttachment(key, id, target))
    return { dir: target, files: out }
  })
  /** Stores email attachments (sub quotes) with a company on a job, shared with the team. */
  handle('att:toBidder', async (key: string, ids: string[], jobId: string, bidderId: string | null) => {
    const out = []
    for (const id of ids) {
      const a = await mail.attachmentContent(key, id)
      out.push(await backend.call('addFile', [jobId, bidderId, a.filename, a.contentType, a.content.toString('base64')]))
    }
    return out
  })

  // quote files stored with jobs
  handle('files:addFromDisk', async (jobId: string, bidderId: string | null, paths?: string[]) => {
    let list = paths
    if (!list) {
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
      if (r.canceled) return []
      list = r.filePaths
    }
    const out = []
    for (const p of list) {
      const ext = path.extname(p).toLowerCase()
      const type = ext === '.pdf' ? 'application/pdf' : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream'
      out.push(await backend.call('addFile', [jobId, bidderId, path.basename(p), type, fs.readFileSync(p).toString('base64')]))
    }
    return out
  })
  handle('files:open', async (fileId: string) => {
    const f = await backend.call('getFile', [fileId])
    if (!f) throw new Error('File not found')
    const dir = path.join(app.getPath('temp'), 'BidMail', fileId.slice(0, 8))
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, String(f.meta.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'))
    fs.writeFileSync(p, Buffer.from(f.base64, 'base64'))
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
    return p
  })
  handle('files:saveAs', async (fileId: string) => {
    const f = await backend.call('getFile', [fileId])
    if (!f) throw new Error('File not found')
    const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('downloads'), f.meta.name) })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, Buffer.from(f.base64, 'base64'))
    return r.filePath
  })

  // bulk invitations
  handle('bulk:start', (input) => bulk.start(input))
  handle('bulk:cancel', (runId: string) => bulk.cancel(runId))

  // calendar: open an .ics file in the default calendar app (Outlook, Windows Calendar, macOS Calendar)
  handle('cal:openIcs', async (name: string, content: string) => {
    const dir = path.join(app.getPath('temp'), 'BidMail')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, (name || 'event').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) + '.ics')
    fs.writeFileSync(file, content, 'utf8')
    const err = await shell.openPath(file)
    if (err) throw new Error('No calendar app is set up to open .ics files. (' + err + ')')
    return file
  })

  // printing
  handle('print:html', (html: string) => printHtml(html))
  handle('pdf:html', async (html: string, defaultName: string) => {
    const name = (defaultName || 'BidMail').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120)
    let target: string | undefined
    if (process.env.BIDMAIL_PDF_DIR) target = path.join(process.env.BIDMAIL_PDF_DIR, name + '.pdf') // automated tests
    else {
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: path.join(app.getPath('documents'), name + '.pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (r.canceled || !r.filePath) return null
      target = r.filePath
    }
    fs.writeFileSync(target, await htmlToPdf(html))
    return target
  })

  // updates
  handle('update:status', () => updater.status)
  handle('update:check', () => {
    updater.check()
    return updater.status
  })
  handle('update:install', () => updater.install())
  handle('updates:publish', async (version: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the new BidMail installer to share with your team',
      properties: ['openFile'],
      filters: [{ name: 'Installer', extensions: ['exe', 'zip'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    return publishInstaller(r.filePaths[0], version, BidBackend.updatesDir())
  })
  handle('updates:folder', () => BidBackend.updatesDir())

  // dialogs / shell
  handle('dialog:openFiles', async (): Promise<PickedFile[]> => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
    if (r.canceled) return []
    return r.filePaths.map((p) => ({ path: p, name: path.basename(p), size: fs.statSync(p).size }))
  })
  handle('dialog:pickFolder', async (defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('dialog:saveText', async (defaultName: string, text: string) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'CSV (Excel)', extensions: ['csv'] }]
    })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, '\ufeff' + text, 'utf8') // BOM so Excel reads UTF-8 correctly
    return r.filePath
  })
  handle('dialog:openText', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    return fs.readFileSync(r.filePaths[0], 'utf8').replace(/^\ufeff/, '')
  })
  handle('file:stat', (p: string) => {
    const st = fs.statSync(p)
    return { path: p, name: path.basename(p), size: st.size, isFile: st.isFile() }
  })
  handle('shell:openExternal', (url: string) => {
    if (!/^(https?|mailto|tel):/i.test(url)) throw new Error('Unsupported link')
    return shell.openExternal(url)
  })
  handle('shell:openPath', async (p: string) => {
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
    return true
  })
  handle('app:info', () => ({ version: app.getVersion(), userData: app.getPath('userData'), platform: process.platform }))
  handle('app:badge', (count: number) => {
    // Unread count on the macOS Dock icon (ignored where unsupported).
    if (process.platform === 'darwin') app.setBadgeCount(Math.max(0, Math.floor(count)))
    return true
  })
}

/** macOS needs a real app menu: without one, Cmd+C/V/X/Z/A, Cmd+Q and Cmd+W do nothing. */
function buildMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'File',
        submenu: [
          { label: 'New Email', accelerator: 'CmdOrCtrl+N', click: () => send('menu:compose', null) },
          { type: 'separator' },
          { role: 'close' }
        ]
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }]
      },
      { role: 'windowMenu' }
    ])
  )
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'BidMail',
    backgroundColor: '#f4f6f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
  })

  // Never navigate the app window away; open links in the default browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
    }
  })

  // Right-click menu with spelling suggestions and clipboard actions.
  win.webContents.on('context-menu', (_e, p) => {
    const items: Electron.MenuItemConstructorOptions[] = []
    for (const s of p.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => win?.webContents.replaceMisspelling(s) })
    }
    if (p.misspelledWord) {
      items.push({
        label: 'Add to dictionary',
        click: () => win?.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord)
      })
      items.push({ type: 'separator' })
    }
    if (p.linkURL) items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) })
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' })
    else if (p.selectionText) items.push({ role: 'copy' })
    if (items.length) Menu.buildFromTemplate(items).popup()
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusWindow())

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.bidmail.app')
    buildMenu()
    const s = getSettings()
    nativeTheme.themeSource = s.reading.theme
    snoozer = new SnoozeService(mail, dataFile('snoozes.json'))
    rules = new RulesRunner(mail, dataFile('rules.json'))
    snoozer.on('woke', ({ snooze, uid }) => {
      send('mail:new', { accountId: snooze.accountId, path: snooze.returnFolder, messages: [] })
      notify('Snoozed email is back', `${snooze.from}: ${snooze.subject}`, () => {
        if (uid != null) send('mail:open', { accountId: snooze.accountId, path: snooze.returnFolder, uid })
      })
    })
    registerIpc()
    await backend.configure(s.team)
    createWindow()
    mail.startWatchers()
    snoozer.start()
    configureUpdates()
    startReminders({
      get: () => getSettings().reminders,
      markNotified: (day) => saveSettings({ reminders: { ...getSettings().reminders, lastNotified: day } }),
      summary: (days) => backend.call('todaySummary', [days]),
      notify: (title, body) => notify(title, body, () => send('nav:go', { kind: 'today' }))
    })
  })

  // macOS convention: closing the window keeps the app (and new-mail alerts) running; clicking the Dock icon reopens it.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (!win || win.isDestroyed()) createWindow()
  })

  app.on('before-quit', async (e) => {
    if ((app as any).__cleaned) return
    e.preventDefault()
    ;(app as any).__cleaned = true
    snoozer?.stop()
    await Promise.race([Promise.all([mail.disconnectAll(), backend.shutdown()]), new Promise((r) => setTimeout(r, 2000))])
    app.quit()
  })
}