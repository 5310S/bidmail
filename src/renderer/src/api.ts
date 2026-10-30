// Typed wrappers over the preload bridge.
import type {
  AccountSaveInput, AppSettings, BulkSendInput, ComposeData, MailAccount, MailFolder, MessageDetail, MessageList,
  LeopardProjectInfo, LeopardStatus, PickedFile, TakeoffAnalysisResult, TeamSettings, TeamStatus
} from '../../shared/ipc'
import type {
  Activity, Addendum, AuditEntry, Bidder, BidderAction, BidderActionInput, Company, CompanyWithStats, EmailMatch, FileMeta, Job,
  JobDetail, JobSummary, Milestone, Takeoff, TeamUser, Template, TodaySummary, Trade, TradeTakeoffLine, WorkflowConfig
} from '../../shared/types'
import type { MailRule } from '../../shared/rules'

export const invoke = <T = any>(channel: string, ...args: unknown[]): Promise<T> => window.bidmail.invoke(channel, ...args)
export const on = (channel: string, cb: (payload: any) => void) => window.bidmail.on(channel, cb)
export const pathForFile = (f: File) => window.bidmail.pathForFile(f)

const call = <T = any>(method: string, ...args: unknown[]) => invoke<T>('bid:call', method, args)

export const bid = {
  listJobs: () => call<JobSummary[]>('listJobs'),
  getJob: (id: string) => call<JobDetail | null>('getJob', id),
  createJob: (data: Partial<Job>) => call<Job>('createJob', data),
  updateJob: (id: string, data: Partial<Job>) => call<Job>('updateJob', id, data),
  deleteJob: (id: string) => call<boolean>('deleteJob', id),
  copyTrades: (target: string, source: string, includeBidders: boolean) => call('copyTrades', target, source, includeBidders),
  addTrade: (jobId: string, data: Partial<Trade>) => call<Trade>('addTrade', jobId, data),
  addTrades: (jobId: string, list: { name: string; csiCode?: string }[]) => call('addTrades', jobId, list),
  updateTrade: (id: string, data: Partial<Trade>) => call<Trade>('updateTrade', id, data),
  deleteTrade: (id: string) => call('deleteTrade', id),
  addBidder: (tradeId: string, data: Partial<Bidder>) => call<Bidder>('addBidder', tradeId, data),
  addBidders: (tradeId: string, list: Partial<Bidder>[]) => call('addBidders', tradeId, list),
  updateBidder: (id: string, data: Partial<Bidder>) => call<Bidder>('updateBidder', id, data),
  deleteBidder: (id: string) => call('deleteBidder', id),
  moveBidder: (id: string, tradeId: string) => call('moveBidder', id, tradeId),
  bidderAction: (id: string, action: BidderAction, input: BidderActionInput = {}) => call<Bidder>('bidderAction', id, action, input),
  addNote: (jobId: string, note: string, bidderId: string | null = null) => call('addNote', jobId, note, bidderId),
  listActivities: (jobId: string, bidderId?: string) => call<Activity[]>('listActivities', jobId, bidderId ?? null),
  listCompanies: (search = '') => call<CompanyWithStats[]>('listCompanies', search),
  saveCompany: (data: Partial<Company>) => call<Company>('saveCompany', data),
  deleteCompany: (id: string) => call('deleteCompany', id),
  importCompanies: (rows: Partial<Company>[]) => call<{ added: number; updated: number }>('importCompanies', rows),
  listTemplates: () => call<Template[]>('listTemplates'),
  saveTemplate: (data: Partial<Template>) => call<Template>('saveTemplate', data),
  deleteTemplate: (id: string) => call('deleteTemplate', id),
  emailIndex: () => call<EmailMatch[]>('emailIndex'),
  exportJobCsv: (jobId: string) => call<string>('exportJobCsv', jobId),
  addAddendum: (jobId: string, data: Partial<Addendum>) => call<Addendum>('addAddendum', jobId, data),
  updateAddendum: (id: string, data: Partial<Addendum>) => call<Addendum>('updateAddendum', id, data),
  deleteAddendum: (id: string) => call('deleteAddendum', id),
  markAddendumSent: (addendumId: string, bidderIds: string[]) => call('markAddendumSent', addendumId, bidderIds),
  setAddendumAck: (addendumId: string, bidderId: string, at: string | null) => call('setAddendumAck', addendumId, bidderId, at),
  listFiles: (jobId: string) => call<FileMeta[]>('listFiles', jobId),
  deleteFile: (id: string) => call('deleteFile', id),
  todaySummary: (days: number) => call<TodaySummary>('todaySummary', days),
  listAudit: (jobId?: string | null, limit = 300) => call<AuditEntry[]>('listAudit', jobId ?? null, limit),
  getWorkflow: () => call<WorkflowConfig>('getWorkflow'),
  saveWorkflow: (cfg: WorkflowConfig) => call<WorkflowConfig>('saveWorkflow', cfg),
  addMilestone: (jobId: string, data: Partial<Milestone>) => call<Milestone>('addMilestone', jobId, data),
  updateMilestone: (id: string, data: Partial<Milestone>) => call<Milestone>('updateMilestone', id, data),
  deleteMilestone: (id: string) => call('deleteMilestone', id),
  applyMilestoneTemplate: (jobId: string) => call<Milestone[]>('applyMilestoneTemplate', jobId),
  setTakeoff: (jobId: string, patch: Partial<Takeoff>) => call<Takeoff>('setTakeoff', jobId, patch),
  setBidderStep: (bidderId: string, stepId: string, done: boolean, at?: string) => call<Bidder>('setBidderStep', bidderId, stepId, done, at),
  applyTakeoffPackages: (jobId: string, packages: { tradeName: string; csiCode: string; lines: TradeTakeoffLine[]; companyIds?: string[] }[]) =>
    call<{ created: number; updated: number; companies: number }>('applyTakeoffPackages', jobId, packages)
}

export interface VendorImportResult {
  file: string
  title: string
  added: number
  updated: number
  skipped: number
  total: number
  trades: number
}

export const vendors = {
  /** Pick an Excel (.xlsx) or CSV vendor list and import its companies. null = cancelled. */
  import: (filePath?: string) => invoke<VendorImportResult | null>('vendors:import', filePath)
}

export const leopardApi = {
  status: () => invoke<LeopardStatus>('leopard:status'),
  login: (url: string, email: string, password: string) => invoke<LeopardStatus>('leopard:login', url, email, password),
  logout: () => invoke<LeopardStatus>('leopard:logout'),
  projects: () => invoke<LeopardProjectInfo[]>('leopard:projects'),
  link: (jobId: string, projectId: string | null) => invoke<Job | null>('leopard:link', jobId, projectId),
  importTakeoff: (jobId: string) => invoke<TakeoffAnalysisResult>('leopard:import', jobId),
  open: (projectId?: string, itemId?: string) => invoke('leopard:open', projectId, itemId)
}

export const files = {
  addFromDisk: (jobId: string, bidderId: string | null) => invoke<FileMeta[]>('files:addFromDisk', jobId, bidderId),
  fromAttachments: (key: string, ids: string[], jobId: string, bidderId: string | null) => invoke<FileMeta[]>('att:toBidder', key, ids, jobId, bidderId),
  open: (id: string) => invoke<string>('files:open', id),
  saveAs: (id: string) => invoke<string | null>('files:saveAs', id)
}

export interface ServerCert {
  pem: string
  fingerprint: string
  subject: string
  validTo: string
  trusted: boolean
}

export const team = {
  apply: (t: Partial<TeamSettings>) => invoke<TeamStatus>('team:apply', t),
  cert: (url: string) => invoke<ServerCert | null>('team:cert', url),
  test: (url: string, certPem?: string) => invoke<string>('team:test', url, certPem),
  health: (url: string, certPem?: string) => invoke<{ needsSetup: boolean; https: boolean; version: number }>('team:health', url, certPem),
  login: (url: string, username: string, password: string, certPem?: string) => invoke<TeamStatus>('team:login', url, username, password, certPem),
  setup: (url: string, setupKey: string, username: string, password: string, displayName: string, certPem?: string) =>
    invoke<TeamStatus>('team:setup', url, setupKey, username, password, displayName, certPem),
  logout: () => invoke<TeamStatus>('team:logout'),
  changePassword: (current: string, next: string) => invoke<TeamStatus>('team:password', current, next),
  users: () => invoke<TeamUser[]>('team:users'),
  createUser: (u: { username: string; displayName?: string; password: string; role?: 'admin' | 'member' }) => invoke<TeamUser>('team:createUser', u),
  updateUser: (id: string, patch: { displayName?: string; role?: 'admin' | 'member'; active?: boolean; password?: string }) =>
    invoke<TeamUser>('team:updateUser', id, patch)
}

export interface SnoozeItem {
  id: string
  accountId: string
  messageId: string
  subject: string
  from: string
  until: string
  returnFolder: string
}

export const snooze = {
  add: (accountId: string, folder: string, uid: number, until: string) => invoke<SnoozeItem>('snooze:add', accountId, folder, uid, until),
  list: () => invoke<SnoozeItem[]>('snooze:list'),
  wake: (id: string) => invoke<boolean>('snooze:wake', id)
}

export const rules = {
  list: () => invoke<MailRule[]>('rules:list'),
  save: (list: MailRule[]) => invoke<MailRule[]>('rules:save', list),
  run: (accountId?: string) => invoke<number>('rules:run', accountId)
}

export interface UpdateStatus {
  state: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'
  feedUrl: string
  version?: string
  progress?: number
  error?: string
  checkedAt?: string
}

export const updates = {
  status: () => invoke<UpdateStatus>('update:status'),
  check: () => invoke<UpdateStatus>('update:check'),
  install: () => invoke('update:install'),
  publish: (version: string) => invoke<string | null>('updates:publish', version),
  folder: () => invoke<string>('updates:folder')
}

export const mail = {
  folders: (accountId: string) => invoke<MailFolder[]>('mail:folders', accountId),
  list: (accountId: string, folder: string, offset = 0, limit = 60) => invoke<MessageList>('mail:list', accountId, folder, offset, limit),
  search: (accountId: string, folder: string, q: string) => invoke<MessageList>('mail:search', accountId, folder, q),
  get: (accountId: string, folder: string, uid: number) => invoke<MessageDetail>('mail:get', accountId, folder, uid),
  flags: (accountId: string, folder: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) =>
    invoke('mail:flags', accountId, folder, uids, flags),
  move: (accountId: string, folder: string, uids: number[], dest: string) => invoke('mail:move', accountId, folder, uids, dest),
  remove: (accountId: string, folder: string, uids: number[]) => invoke('mail:delete', accountId, folder, uids),
  archive: (accountId: string, folder: string, uids: number[]) => invoke('mail:archive', accountId, folder, uids),
  send: (data: ComposeData) => invoke<{ messageId: string }>('mail:send', data),
  saveDraft: (data: ComposeData) => invoke<{ path: string; uid: number } | null>('mail:draft', data),
  openAttachment: (key: string, id: string) => invoke<string>('att:open', key, id),
  saveAttachment: (key: string, id: string) => invoke<string | null>('att:save', key, id),
  saveAll: (key: string, ids: string[], dir?: string) => invoke<{ dir: string; files: string[] } | null>('att:saveAll', key, ids, dir),
  rsvp: (accountId: string, key: string, status: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED') => invoke<boolean>('mail:rsvp', accountId, key, status)
}

export const accounts = {
  list: () => invoke<MailAccount[]>('accounts:list'),
  save: (input: AccountSaveInput) => invoke<MailAccount>('accounts:save', input),
  remove: (id: string) => invoke('accounts:delete', id),
  test: (account: MailAccount, password?: string) => invoke<string>('accounts:test', account, password),
  oauth: (provider: 'microsoft' | 'google', existingId?: string) => invoke<MailAccount>('accounts:oauth', provider, existingId)
}

export const settingsApi = {
  get: () => invoke<AppSettings>('settings:get'),
  save: (patch: Partial<AppSettings>) => invoke<AppSettings>('settings:save', patch),
  teamStatus: () => invoke<TeamStatus>('bid:status')
}

export const bulk = {
  start: (input: BulkSendInput) => invoke<string>('bulk:start', input),
  cancel: (runId: string) => invoke('bulk:cancel', runId)
}

export const sys = {
  openFiles: () => invoke<PickedFile[]>('dialog:openFiles'),
  pickFolder: (defaultPath?: string) => invoke<string | null>('dialog:pickFolder', defaultPath),
  saveText: (name: string, text: string) => invoke<string | null>('dialog:saveText', name, text),
  openText: () => invoke<string | null>('dialog:openText'),
  stat: (p: string) => invoke<{ path: string; name: string; size: number; isFile: boolean }>('file:stat', p),
  openExternal: (url: string) => invoke('shell:openExternal', url),
  openPath: (p: string) => invoke('shell:openPath', p),
  openIcs: (name: string, content: string) => invoke<string>('cal:openIcs', name, content),
  print: (html: string) => invoke<boolean>('print:html', html),
  savePdf: (html: string, name: string) => invoke<string | null>('pdf:html', html, name),
  appInfo: () => invoke<{ version: string; userData: string; platform: string }>('app:info')
}