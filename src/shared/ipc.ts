import type { CalendarEvent } from './ics'
import type { TeamUser } from './types'

// Types shared between the main process and the renderer over IPC.

export type TeamMode = 'local' | 'remote' | 'host'

export interface TeamSettings {
  mode: TeamMode
  url: string // remote server URL, e.g. https://192.168.1.20:4780
  key: string // setup key (host: lets the first admin be created / older apps connect)
  port: number // port when hosting
  https: boolean // host: serve over HTTPS with a self-signed certificate
  username: string // remote: signed-in user name
  token: string // remote: session token (encrypted at rest)
  certPem: string // remote: pinned self-signed certificate of the server
}

export interface ReadingSettings {
  fontSize: number // px for message bodies
  loadRemoteImages: boolean
  simpleView: boolean
  theme: 'light' | 'dark' | 'system'
  /** Group messages into conversations in the message list. */
  conversations: boolean
}

/** App registrations for Sign in with Microsoft / Google (set once per company). */
export interface OAuthSettings {
  microsoftClientId: string
  microsoftTenant: string
  googleClientId: string
  googleClientSecret: string
}

export interface ReminderSettings {
  enabled: boolean
  hour: number // local hour, 0-23
  followUpDays: number
  lastNotified: string // YYYY-MM-DD
}

export interface UpdateSettings {
  /** Folder with latest.yml. Empty = use the team server's /updates. */
  url: string
  enabled: boolean
}

export interface AppSettings {
  userName: string
  companyName: string
  team: TeamSettings
  reading: ReadingSettings
  trustedImageSenders: string[]
  sendDelayMs: number
  notifications: boolean
  oauth: OAuthSettings
  reminders: ReminderSettings
  updates: UpdateSettings
  leopard: LeopardSettings
}

/** This computer's Leopard sign-in (each person uses their own Leopard account). */
export interface LeopardSettings {
  url: string
  /** The email used to sign in to Leopard (a mail account's address, or a separate one). */
  email: string
  /** Leopard's session cookie, encrypted on disk; shown to the screens only as "(signed in)". */
  cookie: string
}

export interface LeopardStatus {
  url: string
  signedIn: boolean
  email: string
  usedBytes: number | null
  quotaBytes: number | null
  error: string
}

export interface LeopardProjectInfo {
  id: string
  name: string
  number: string
  location: string
  changed: number | null
  takeoffSaved: number | null
  fileCount: number
  deleted?: boolean
}

/** Whether the job's imported takeoff is still current with Leopard. */
export interface LeopardCheck {
  state: 'unlinked' | 'signed_out' | 'offline' | 'gone' | 'deleted' | 'no_takeoff' | 'not_imported' | 'changed' | 'current'
  /** When the takeoff was last saved in Leopard (ms). */
  takeoffSaved: number | null
  message: string
}

export interface TakeoffPackagePreview {
  tradeName: string
  csiCode: string
  lines: { description: string; quantity: number | null; unit: string; sheet: string; itemId?: string }[]
  totals: { unit: string; quantity: number }[]
  /** The job's trade this package updates; null = a new trade gets created. */
  existingTradeId: string | null
  existingTradeName: string
}

export interface TakeoffAnalysisResult {
  projectId: string
  projectName: string
  savedAt: number | null
  itemCount: number
  missingQuantities: number
  packages: TakeoffPackagePreview[]
  /** Where the copy was saved: BidMail job files, and the Leopard project's storage. */
  bidmailFile: string | null
  leopardFile: string | null
  warnings: string[]
}

export interface TeamStatus {
  mode: TeamMode
  connected: boolean
  url: string
  addresses: string[]
  error: string
  revision: number
  https: boolean
  /** Host with HTTPS: certificate fingerprint teammates should see when they trust it. */
  fingerprint: string
  /** Remote: the signed-in user. */
  user: TeamUser | null
  needsLogin: boolean
  needsSetup: boolean
  /** Host: number of teammate logins created. */
  userCount: number
}

export interface ServerConfig {
  host: string
  port: number
  secure: boolean // true = TLS on connect (993/465), false = STARTTLS / plain
  user: string
}

export interface MailAccount {
  id: string
  displayName: string
  email: string
  imap: ServerConfig
  smtp: ServerConfig
  signature: string // HTML
  color: string
  saveSentCopy: boolean // append sent mail to the Sent folder (Gmail/Outlook do this automatically)
  allowInvalidCerts: boolean
  /** 'oauth' = Sign in with Microsoft/Google (the saved secret is a refresh token). */
  authType?: 'password' | 'oauth'
  oauthProvider?: 'microsoft' | 'google'
  hasPassword?: boolean
}

export interface AccountSaveInput {
  account: MailAccount
  password?: string // omitted = keep existing
}

export interface MailFolder {
  path: string
  name: string
  specialUse: string // \Inbox, \Sent, \Drafts, \Trash, \Junk, \Archive, \All, \Flagged or ''
  delimiter: string
  unseen: number
  total: number
  depth: number
}

export interface Address {
  name: string
  address: string
}

export interface MessageSummary {
  uid: number
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  date: string
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  hasAttachments: boolean
  size: number
  /** Message-ID and In-Reply-To headers, used to group conversations. */
  messageId: string
  inReplyTo: string
}

export interface MessageList {
  messages: MessageSummary[]
  total: number
  hasMore: boolean
  /** Set when the server could not be reached and this is the copy saved on this computer. */
  offline?: string
  savedAt?: string
}

export interface AttachmentInfo {
  id: string
  filename: string
  contentType: string
  size: number
}

export interface MessageDetail extends MessageSummary {
  key: string // cache key used for attachment operations
  replyTo: Address[]
  bcc: Address[]
  html: string
  text: string
  hasRemoteImages: boolean
  attachments: AttachmentInfo[]
  messageId: string
  references: string[]
  /** Meeting invite found in the message (text/calendar), if any. */
  invite: CalendarEvent | null
  inviteAttachmentId: string | null
  /** True when opened from the copy saved on this computer while offline. */
  fromCache?: boolean
}

export interface ComposeAttachment {
  filename: string
  path?: string // local file
  size?: number
  source?: { key: string; id: string } // attachment of an existing message (forwarding)
}

export interface ComposeData {
  accountId: string
  to: string
  cc: string
  bcc: string
  subject: string
  html: string
  attachments: ComposeAttachment[]
  inReplyTo?: string
  references?: string[]
  answered?: { path: string; uid: number }
  draft?: { path: string; uid: number }
}

export interface BulkSendInput {
  accountId: string
  jobId: string
  bidderIds: string[]
  subject: string
  body: string
  cc?: string
  attachments: ComposeAttachment[]
  markAs: 'drawings_sent' | 'follow_up_email' | 'addendum' | 'none'
  /** With markAs 'addendum': which addendum is being sent (stamps it on each company). */
  addendumId?: string
}

export interface BulkProgress {
  runId: string
  bidderId: string
  state: 'queued' | 'sending' | 'sent' | 'failed' | 'skipped' | 'cancelled'
  error?: string
  done: boolean
}

export interface PickedFile {
  path: string
  name: string
  size: number
}