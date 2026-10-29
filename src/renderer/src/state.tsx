import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, ComposeData, MailAccount, MailFolder, TeamStatus } from '../../shared/ipc'
import type { EmailMatch, JobSummary, TodaySummary } from '../../shared/types'
import { accounts as accountsApi, bid, invoke, mail, on, settingsApi, updates, UpdateStatus } from './api'
import { ConfirmDialog, ToastItem, Toasts } from './components/ui'

export type View =
  | { kind: 'mail'; accountId: string; folder: string }
  | { kind: 'unified' }
  | { kind: 'today' }
  | { kind: 'jobs' }
  | { kind: 'job'; jobId: string; tab?: string }
  | { kind: 'companies' }
  | { kind: 'templates' }
  | { kind: 'settings'; tab?: string }

export interface ComposeInit extends Partial<ComposeData> {
  heading?: string
  /** When set, sending this email records the checkpoint on this company (e.g. from a job page). */
  bidderAction?: { bidderId: string; action: 'drawings_sent' | 'follow_up_email' }
  /** Job/company used to fill {{merge_fields}} when inserting a template. */
  merge?: { jobId: string; bidderId: string }
}

interface ConfirmOpts {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
}

interface Ctx {
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  accounts: MailAccount[]
  reloadAccounts: () => Promise<void>
  folders: Record<string, MailFolder[]>
  folderErrors: Record<string, string>
  reloadFolders: (accountId?: string) => void
  accountOnline: Record<string, boolean>
  team: TeamStatus | null
  setTeam: (t: TeamStatus) => void
  rev: number
  jobs: JobSummary[]
  emailIndex: Map<string, EmailMatch[]>
  view: View
  go: (v: View) => void
  toast: (text: string, kind?: ToastItem['kind']) => void
  compose: (init?: ComposeInit) => void
  composeState: ComposeInit | null
  closeCompose: () => void
  confirm: (o: ConfirmOpts) => Promise<boolean>
  mailTick: number
  today: TodaySummary | null
  update: UpdateStatus | null
  openRequest: { accountId: string; path: string; uid: number } | null
  clearOpenRequest: () => void
}

const AppCtx = createContext<Ctx>(null as any)
export const useApp = () => useContext(AppCtx)

/** Runs a bid-data query and re-runs it whenever shared data changes (including teammates' edits). */
export function useBidQuery<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string; reload: () => void; loading: boolean } {
  const { rev } = useApp()
  const [data, setData] = useState<T>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    fn()
      .then((d) => {
        if (live) {
          setData(d)
          setError('')
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, n, ...deps])
  return { data, error, loading, reload: () => setN((x) => x + 1) }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [folders, setFolders] = useState<Record<string, MailFolder[]>>({})
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>({})
  const [accountOnline, setAccountOnline] = useState<Record<string, boolean>>({})
  const [team, setTeam] = useState<TeamStatus | null>(null)
  const [rev, setRev] = useState(0)
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [index, setIndex] = useState<EmailMatch[]>([])
  const [view, setView] = useState<View>({ kind: 'jobs' })
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [composeState, setComposeState] = useState<ComposeInit | null>(null)
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null)
  const [mailTick, setMailTick] = useState(0)
  const [today, setToday] = useState<TodaySummary | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [openRequest, setOpenRequest] = useState<Ctx['openRequest']>(null)
  const toastId = useRef(1)
  const viewSet = useRef(false)

  const toast = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = toastId.current++
    setToasts((t) => [...t.slice(-3), { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000)
  }, [])

  const accountsRef = useRef<MailAccount[]>([])
  const reloadFolders = useCallback((accountId?: string) => {
    for (const a of accountsRef.current) {
      if (accountId && a.id !== accountId) continue
      mail
        .folders(a.id)
        .then((f) => {
          setFolders((prev) => ({ ...prev, [a.id]: f }))
          setFolderErrors((prev) => ({ ...prev, [a.id]: '' }))
        })
        .catch((e) => setFolderErrors((prev) => ({ ...prev, [a.id]: e.message })))
    }
  }, [])

  const reloadAccounts = useCallback(async () => {
    const list = await accountsApi.list()
    accountsRef.current = list
    setAccounts(list)
    reloadFolders()
    if (!viewSet.current && list.length) {
      viewSet.current = true
      setView({ kind: 'mail', accountId: list[0].id, folder: 'INBOX' })
    }
  }, [reloadFolders])

  useEffect(() => {
    settingsApi.get().then(setSettings)
    settingsApi.teamStatus().then(setTeam)
    updates.status().then(setUpdate).catch(() => {})
    reloadAccounts()
    const offs = [
      on('bid:changed', (r: number) => setRev(r)),
      on('bid:status', (s: TeamStatus) => {
        setTeam(s)
        setRev((r) => r + 0.001) // refetch after reconnecting
      }),
      on('mail:new', (ev: { accountId: string }) => {
        setMailTick((t) => t + 1)
        reloadFolders(ev.accountId)
      }),
      on('mail:open', (req) => {
        setView({ kind: 'mail', accountId: req.accountId, folder: req.path })
        setOpenRequest(req)
      }),
      on('menu:compose', () => setComposeState({})),
      on('nav:go', (v: View) => {
        viewSet.current = true
        setView(v)
      }),
      on('update:status', (u: UpdateStatus) => setUpdate(u)),
      on('mail:accountStatus', (s: { accountId: string; online: boolean }) =>
        setAccountOnline((p) => ({ ...p, [s.accountId]: s.online }))
      )
    ]
    const timer = setInterval(() => reloadFolders(), 120000)
    return () => {
      offs.forEach((o) => o())
      clearInterval(timer)
    }
  }, [reloadAccounts, reloadFolders])

  useEffect(() => {
    bid.listJobs().then(setJobs).catch(() => {})
    bid.emailIndex().then(setIndex).catch(() => {})
    bid.todaySummary(settings?.reminders.followUpDays ?? 3).then(setToday).catch(() => {})
  }, [rev, settings?.reminders.followUpDays])

  // Refresh 'Today' every 15 minutes so follow-ups become due without any change happening.
  useEffect(() => {
    const t = setInterval(() => bid.todaySummary(settings?.reminders.followUpDays ?? 3).then(setToday).catch(() => {}), 900000)
    return () => clearInterval(t)
  }, [settings?.reminders.followUpDays])

  useEffect(() => {
    if (!settings) return
    const t = settings.reading.theme
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [settings])

  // Dock badge (macOS): total unread across every account's inbox.
  useEffect(() => {
    let n = 0
    for (const list of Object.values(folders)) for (const f of list) if (f.specialUse === '\\Inbox') n += f.unseen
    invoke('app:badge', n).catch(() => {})
  }, [folders])

  const emailIndex = useMemo(() => {
    const m = new Map<string, EmailMatch[]>()
    for (const e of index) m.set(e.email, [...(m.get(e.email) ?? []), e])
    return m
  }, [index])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings(await settingsApi.save(patch))
  }, [])

  const confirm = useCallback(
    (o: ConfirmOpts) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })),
    []
  )

  if (!settings) return <div className="boot">Loading BidMail...</div>

  const value: Ctx = {
    settings, updateSettings, accounts, reloadAccounts, folders, folderErrors, reloadFolders, accountOnline,
    team, setTeam, rev, jobs, emailIndex, view,
    go: (v) => {
      viewSet.current = true
      setView(v)
    },
    toast,
    compose: (init) => setComposeState({ ...(init ?? {}) }),
    composeState,
    closeCompose: () => setComposeState(null),
    confirm, mailTick, today, update, openRequest, clearOpenRequest: () => setOpenRequest(null)
  }

  return (
    <AppCtx.Provider value={value}>
      {children}
      <Toasts items={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger={confirmState.danger}
          onConfirm={() => {
            confirmState.resolve(true)
            setConfirmState(null)
          }}
          onCancel={() => {
            confirmState.resolve(false)
            setConfirmState(null)
          }}
        />
      )}
    </AppCtx.Provider>
  )
}