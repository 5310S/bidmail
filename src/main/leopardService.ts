// Leopard in BidMail: this computer's Leopard sign-in, linking jobs to Leopard projects, and importing a
// project's takeoff: a copy is saved (with the job's files and in the Leopard project's storage), then the
// takeoff is analyzed into trade packages that set up trades and request-for-bid emails.
import { getSettings, saveSettings } from './settings'
import { LeopardAuthError, LeopardClient, LeopardGoneError, normalizeLeopardUrl } from './leopard'
import type { BidBackend } from './bidBackend'
import type { LeopardCheck, LeopardProjectInfo, LeopardStatus, TakeoffAnalysisResult } from '../shared/ipc'
import type { JobDetail } from '../shared/types'
import { fmtQty, matchTrade, normalizeTakeoff, packageTakeoff } from '../shared/takeoffAnalysis'
import { leopardQuantity } from '../shared/leopardQuantity'

const SNAPSHOT_PREFIX = 'Leopard takeoff - '
const MAX_SNAPSHOT = 20 * 1024 * 1024

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
}
const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export class LeopardService {
  private lastStatus: LeopardStatus | null = null

  constructor(private backend: BidBackend) {}

  private client() {
    const s = getSettings().leopard
    return new LeopardClient(s.url, s.cookie)
  }

  /** Runs a Leopard request; an expired sign-in clears the saved cookie so the screens ask to sign in again. */
  private async use<T>(fn: (c: LeopardClient) => Promise<T>): Promise<T> {
    const c = this.client()
    if (!c.cookie) throw new LeopardAuthError('Sign in to Leopard first (Settings > Leopard).')
    try {
      return await fn(c)
    } catch (e) {
      if (e instanceof LeopardAuthError) saveSettings({ leopard: { ...getSettings().leopard, cookie: '' } })
      throw e
    }
  }

  async status(): Promise<LeopardStatus> {
    const s = getSettings().leopard
    const base: LeopardStatus = { url: normalizeLeopardUrl(s.url), signedIn: false, email: s.email, usedBytes: null, quotaBytes: null, error: '' }
    if (!s.cookie) return (this.lastStatus = base)
    try {
      const me = await this.use((c) => c.me())
      return (this.lastStatus = { ...base, signedIn: true, email: me.email || s.email, usedBytes: me.usedBytes, quotaBytes: me.quotaBytes })
    } catch (e: any) {
      // Offline: still signed in, just can't show storage right now.
      const signedIn = !(e instanceof LeopardAuthError)
      return (this.lastStatus = { ...base, signedIn, error: e?.message ?? String(e) })
    }
  }

  async login(url: string, email: string, password: string): Promise<LeopardStatus> {
    if (!email.trim() || !password) throw new Error('Enter your Leopard email and password')
    const c = new LeopardClient(url)
    // Leopard's login answer has the account and its storage: no second call needed.
    const acct = await c.login(email, password)
    saveSettings({ leopard: { url: c.base, email: email.trim(), cookie: c.cookie } })
    return (this.lastStatus = { url: c.base, signedIn: true, email: acct.email || email.trim(), usedBytes: acct.usedBytes, quotaBytes: acct.quotaBytes, error: '' })
  }

  async logout(): Promise<LeopardStatus> {
    await this.client().logout().catch(() => undefined)
    saveSettings({ leopard: { ...getSettings().leopard, cookie: '' } })
    return this.status()
  }

  projects(): Promise<LeopardProjectInfo[]> {
    return this.use((c) => c.projects())
  }

  async link(jobId: string, projectId: string | null) {
    if (!projectId) return this.backend.call('linkLeopard', [jobId, null])
    const p = (await this.projects()).find((x) => x.id === projectId)
    if (!p) throw new Error('That Leopard project was not found in your account')
    const c = this.client()
    return this.backend.call('linkLeopard', [jobId, { projectId: p.id, projectName: p.name, url: c.projectUrl(p.id) }])
  }


  /** Imports the linked project's takeoff: saves a copy, analyzes it into trade packages, syncs the takeoff card. */
  async importTakeoff(jobId: string): Promise<TakeoffAnalysisResult> {
    const d: JobDetail | null = await this.backend.call('getJob', [jobId])
    if (!d) throw new Error('Job not found')
    const job = d.job
    const link = job.leopard
    if (!link) throw new Error('Link this job to a Leopard project first')
    // A project in Leopard's Recently deleted, or no longer in the account, says so instead of importing.
    const project = (await this.use((c) => c.projects(true))).find((p) => p.id === link.projectId)
    if (!project) throw new LeopardGoneError(`"${link.projectName}" is no longer in your Leopard account. Link the job to its project again.`)
    if (project.deleted) throw new Error(`"${link.projectName}" is in Leopard's Recently deleted. Restore it in Leopard, or link the job to another project.`)
    const { data, saved } = await this.use((c) => c.takeoff(link.projectId))
    if (!data) throw new Error(`"${link.projectName}" has no saved takeoff in Leopard yet`)

    const lines = normalizeTakeoff(data, leopardQuantity)
    if (!lines.length) throw new Error(`The takeoff in "${link.projectName}" has no items yet`)
    const packages = packageTakeoff(lines).map((p) => {
      const t = matchTrade(p, d.trades)
      return {
        tradeName: p.tradeName,
        csiCode: p.csiCode,
        lines: p.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit, sheet: l.sheet, itemId: l.itemId || undefined, ...(l.quantityText ? { quantityText: l.quantityText } : {}), ...(l.isCost ? { isCost: true } : {}) })),
        totals: p.totals,
        existingTradeId: t?.id ?? null,
        existingTradeName: t?.name ?? ''
      }
    })
    const warnings: string[] = []
    // A quantity typed as text in Leopard (e.g. LS) is a quantity: only the rest are missing one.
    const missing = lines.filter((l) => l.quantity == null && !l.quantityText).length
    const unscaled = lines.filter((l) => l.issue === 'unscaled').length
    const unmeasured = missing - unscaled
    if (unscaled) warnings.push(`${unscaled} item(s) are measured only on sheets with no scale, so they have no quantity. Set the scale in Leopard and re-import.`)
    if (unmeasured) warnings.push(`${unmeasured} item(s) aren't measured yet. They're listed without a quantity.`)

    // The copy kept with the job (shared with the team): the takeoff itself plus a readable summary.
    const when = stamp()
    const json = JSON.stringify(data)
    const csv = ['Trade,CSI,Item,Quantity,Unit,Sheets']
      .concat(packages.flatMap((p) => p.lines.map((l) => [p.tradeName, p.csiCode, l.description, l.quantity ?? l.quantityText ?? '', l.unit, l.sheet].map(csvCell).join(','))))
      .join('\r\n')
    let bidmailFile: string | null = null
    try {
      for (const f of d.files.filter((f) => f.name.startsWith(SNAPSHOT_PREFIX))) await this.backend.call('deleteFile', [f.id])
      if (json.length <= MAX_SNAPSHOT) {
        await this.backend.call('addFile', [jobId, null, `${SNAPSHOT_PREFIX}${when}.json`, 'application/json', Buffer.from(json).toString('base64')])
      } else warnings.push('The takeoff is too large to keep a full copy in BidMail; the quantity summary was saved.')
      bidmailFile = `${SNAPSHOT_PREFIX}${when} quantities.csv`
      await this.backend.call('addFile', [jobId, null, bidmailFile, 'text/csv', Buffer.from(csv).toString('base64')])
    } catch (e: any) {
      warnings.push(`Couldn't save the copy with the job: ${e?.message ?? e}`)
    }

    // And in the Leopard project's own storage (the account's 10 GB), next to the takeoff it came from.
    let leopardFile: string | null = null
    try {
      const analysis = {
        app: 'BidMail',
        job: { id: job.id, name: job.name, number: job.number },
        project: { id: link.projectId, name: link.projectName },
        takeoffSaved: saved,
        importedAt: new Date().toISOString(),
        importedBy: getSettings().userName,
        packages: packages.map((p) => ({ trade: p.tradeName, csi: p.csiCode, totals: p.totals.map((t) => fmtQty(t.quantity, t.unit)), lines: p.lines }))
      }
      // One file, replaced on each import (Leopard counts only the change in size against the quota).
      leopardFile = await this.use((c) => c.putFile(link.projectId, 'bidmail-takeoff.json', JSON.stringify(analysis, null, 1), 'application/json'))
    } catch (e: any) {
      warnings.push(`Couldn't save the copy in Leopard storage: ${e?.message ?? e}`)
    }

    await this.backend.call('linkLeopard', [jobId, { takeoffImportedAt: new Date().toISOString(), takeoffPath: leopardFile, itemCount: lines.length, takeoffSavedAt: saved }])

    // Keep the takeoff card in step: Leopard's estimator is who's doing it, and items mean it has started.
    const info = data.info ?? {}
    const patch: Record<string, string> = {}
    if (info.estimator && !job.takeoff.assignee) patch.assignee = String(info.estimator)
    if (job.takeoff.status === 'not_started') patch.status = 'in_progress'
    if (Object.keys(patch).length) await this.backend.call('setTakeoff', [jobId, patch])

    return {
      projectId: link.projectId,
      projectName: link.projectName,
      savedAt: saved,
      itemCount: lines.length,
      missingQuantities: missing,
      packages,
      bidmailFile,
      leopardFile,
      warnings
    }
  }

  /** Is the job's imported takeoff still what's in Leopard? (Leopard's job list has each takeoff's save time.) */
  async check(jobId: string): Promise<LeopardCheck> {
    const d: JobDetail | null = await this.backend.call('getJob', [jobId])
    const link = d?.job.leopard
    if (!link) return { state: 'unlinked', takeoffSaved: null, message: '' }
    if (!getSettings().leopard.cookie) return { state: 'signed_out', takeoffSaved: null, message: 'Sign in to Leopard to check for changes.' }
    let list
    try {
      list = await this.use((c) => c.projects(true))
    } catch (e: any) {
      return { state: e instanceof LeopardAuthError ? 'signed_out' : 'offline', takeoffSaved: null, message: e?.message ?? String(e) }
    }
    const p = list.find((x) => x.id === link.projectId)
    if (!p) return { state: 'gone', takeoffSaved: null, message: 'No longer in your Leopard account. Link it again.' }
    if (p.deleted) return { state: 'deleted', takeoffSaved: p.takeoffSaved, message: "In Leopard's Recently deleted." }
    if (!p.takeoffSaved) return { state: 'no_takeoff', takeoffSaved: null, message: 'No takeoff saved in Leopard yet.' }
    if (!link.takeoffImportedAt) return { state: 'not_imported', takeoffSaved: p.takeoffSaved, message: '' }
    const importedFrom = link.takeoffSavedAt ?? Date.parse(link.takeoffImportedAt)
    const changed = p.takeoffSaved > importedFrom + 1
    return { state: changed ? 'changed' : 'current', takeoffSaved: p.takeoffSaved, message: changed ? 'The takeoff changed in Leopard since it was imported.' : '' }
  }

  /** Leopard itself, or a linked project (and one of its items). */
  openUrl(projectId?: string, itemId?: string): string {
    const c = this.client()
    return projectId ? c.projectUrl(projectId, itemId) : c.base + '/'
  }
}