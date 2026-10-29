// Automatic updates from the team server's /updates folder (or any web folder with latest.yml).
// New versions download in the background; the app offers "Restart to update".
import { app, session } from 'electron'
import { autoUpdater } from 'electron-updater'
import { X509Certificate } from 'node:crypto'
export { publishInstaller } from './updatesFeed'

export interface UpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'
  feedUrl: string
  version?: string
  progress?: number
  error?: string
  checkedAt?: string
}

export class Updater {
  status: UpdateStatus = { state: 'disabled', feedUrl: '' }
  private timer: NodeJS.Timeout | null = null
  private wired = false

  constructor(private onStatus: (s: UpdateStatus) => void) {}

  private set(p: Partial<UpdateStatus>) {
    this.status = { ...this.status, ...p }
    this.onStatus(this.status)
  }

  /** Points the updater at a feed. `pinPem` trusts a self-signed team server certificate for downloads. */
  configure(feedUrl: string, pinPem?: string) {
    const enabled = !!feedUrl && (app.isPackaged || process.env.BIDMAIL_FORCE_UPDATES === '1')
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!enabled) return this.set({ state: 'disabled', feedUrl })
    if (pinPem) {
      const pinned = new X509Certificate(pinPem).fingerprint256
      session.fromPartition('electron-updater', { cache: false }).setCertificateVerifyProc((req, cb) => {
        try {
          cb(new X509Certificate(req.certificate.data).fingerprint256 === pinned ? 0 : -3)
        } catch {
          cb(-3)
        }
      })
    }
    if (!this.wired) {
      this.wired = true
      autoUpdater.autoDownload = true
      // Automated tests set BIDMAIL_NO_AUTO_INSTALL so a downloaded test update is never installed.
      autoUpdater.autoInstallOnAppQuit = process.env.BIDMAIL_NO_AUTO_INSTALL !== '1'
      autoUpdater.logger = null
      autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: undefined }))
      autoUpdater.on('update-available', (i) => this.set({ state: 'downloading', version: i.version, progress: 0 }))
      autoUpdater.on('update-not-available', () => this.set({ state: 'current', checkedAt: new Date().toISOString() }))
      autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round(p.percent) }))
      autoUpdater.on('update-downloaded', (i) => this.set({ state: 'ready', version: i.version, progress: 100 }))
      autoUpdater.on('error', (e) => this.set({ state: 'error', error: e?.message ?? String(e), checkedAt: new Date().toISOString() }))
    }
    if (process.env.BIDMAIL_FORCE_UPDATES === '1') autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl.replace(/\/+$/, '') })
    this.set({ state: 'idle', feedUrl, error: undefined })
    this.check()
    this.timer = setInterval(() => this.check(), 4 * 3600000)
  }

  check() {
    if (this.status.state === 'disabled' || this.status.state === 'ready' || this.status.state === 'downloading') return
    autoUpdater.checkForUpdates().catch((e) => this.set({ state: 'error', error: e?.message ?? String(e) }))
  }

  install() {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall(false, true)
  }
}
