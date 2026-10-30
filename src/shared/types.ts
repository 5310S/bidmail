// Shared domain types used by the Electron main process, the renderer and the team server.

export type JobStatus = 'bidding' | 'submitted' | 'won' | 'lost' | 'archived'

export interface Job {
  id: string
  name: string
  number: string
  client: string
  location: string
  bidDue: string | null // ISO datetime
  drawingsLink: string
  specsLink: string
  folderPath: string
  notes: string
  status: JobStatus
  /** Bid alternates defined by the bid documents (Alternate 1, 2...). accepted = include in leveled totals. */
  alternates: JobAlternate[]
  /** One takeoff per job: who is doing it, how far along, and when it's due. */
  takeoff: Takeoff
  /** The Leopard project this job is linked to (takeoff software), if any. */
  leopard: LeopardLink | null
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export interface LeopardLink {
  projectId: string
  projectName: string
  url: string
  linkedBy: string
  linkedAt: string
  /** Last takeoff import: when, by whom, and where the copy was saved in Leopard storage. */
  takeoffImportedAt: string | null
  takeoffImportedBy: string
  takeoffPath: string | null
  itemCount: number
}

/** One quantity from the takeoff, carried on its trade for request-for-bid emails. */
export interface TradeTakeoffLine {
  description: string
  quantity: number | null
  unit: string
  sheet: string
}

export type TakeoffStatus = 'not_started' | 'in_progress' | 'done' | 'checked'

export interface Takeoff {
  assignee: string
  status: TakeoffStatus
  dueAt: string | null
  notes: string
  updatedBy: string
  updatedAt: string | null
}

export const TAKEOFF_STATUS_LABELS: Record<TakeoffStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  checked: 'Checked'
}

export const EMPTY_TAKEOFF: Takeoff = { assignee: '', status: 'not_started', dueAt: null, notes: '', updatedBy: '', updatedAt: null }

/** A date on the job's timeline: pre-bid meeting, RFI deadline, sub bids due... */
export interface Milestone {
  id: string
  jobId: string
  name: string
  dueAt: string | null
  doneAt: string | null
  owner: string
  notes: string
  sortOrder: number
  updatedBy: string
  updatedAt: string
}

/**
 * One step of the team's bidding process for each company. Built-in kinds are ticked automatically
 * (sending the invitation ticks "drawings_sent", saving a quote ticks "filed"); 'custom' steps are
 * checkmarks anyone can tick.
 */
export type WorkflowStepKind = 'drawings_sent' | 'follow_up' | 'will_bid' | 'price_received' | 'filed' | 'custom'

export interface WorkflowStep {
  id: string
  name: string
  kind: WorkflowStepKind
  enabled: boolean
  changedBy: string
  changedAt: string
}

export interface MilestoneTemplate {
  id: string
  name: string
  /** Default date: this many days before the bid due date (0 = same day). null = no default date. */
  daysBeforeBidDue: number | null
  changedBy: string
  changedAt: string
}

/** The team's shared, customizable process. Anyone can change it; every change carries their name. */
export interface WorkflowConfig {
  steps: WorkflowStep[]
  milestones: MilestoneTemplate[]
  updatedBy: string
  updatedAt: string
}

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  steps: [
    { id: 'drawings_sent', name: 'Emailed drawings', kind: 'drawings_sent', enabled: true, changedBy: '', changedAt: '' },
    { id: 'follow_up', name: 'Called / followed up', kind: 'follow_up', enabled: true, changedBy: '', changedAt: '' },
    { id: 'will_bid', name: 'Confirmed bidding', kind: 'will_bid', enabled: true, changedBy: '', changedAt: '' },
    { id: 'price_received', name: 'Price received', kind: 'price_received', enabled: true, changedBy: '', changedAt: '' },
    { id: 'filed', name: 'Quote filed', kind: 'filed', enabled: true, changedBy: '', changedAt: '' }
  ],
  milestones: [
    { id: 'docs', name: 'Bid documents received', daysBeforeBidDue: null, changedBy: '', changedAt: '' },
    { id: 'invites', name: 'Invitations out', daysBeforeBidDue: 10, changedBy: '', changedAt: '' },
    { id: 'prebid', name: 'Pre-bid meeting', daysBeforeBidDue: null, changedBy: '', changedAt: '' },
    { id: 'rfi', name: 'RFI deadline', daysBeforeBidDue: 5, changedBy: '', changedAt: '' },
    { id: 'takeoff', name: 'Takeoff complete', daysBeforeBidDue: 4, changedBy: '', changedAt: '' },
    { id: 'subs', name: 'Sub bids due', daysBeforeBidDue: 1, changedBy: '', changedAt: '' }
  ],
  updatedBy: '',
  updatedAt: ''
}

/** Who ticked a step, and when. */
export interface StepMark {
  at: string
  by: string
}

/** Done/not done for one step on one company, with who and when. */
export function stepState(b: Bidder, step: WorkflowStep, files: FileMeta[]): (StepMark & { done: true }) | { done: false } {
  const mark = (at: string | null | undefined, by?: string): (StepMark & { done: true }) | { done: false } =>
    at ? { done: true, at, by: by ?? '' } : { done: false }
  switch (step.kind) {
    case 'drawings_sent': return mark(b.drawingsSentAt, b.stepLog.drawings_sent?.by)
    case 'follow_up': return mark(b.lastFollowUpAt, b.stepLog.follow_up?.by)
    case 'will_bid': return mark(b.willBidAt ?? (b.priceReceivedAt ? b.priceReceivedAt : null), b.stepLog.will_bid?.by ?? b.stepLog.price_received?.by)
    case 'price_received': return mark(b.priceReceivedAt, b.stepLog.price_received?.by)
    case 'filed': {
      if (b.steps.filed) return mark(b.steps.filed.at, b.steps.filed.by)
      const f = files.filter((x) => x.bidderId === b.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt))[0]
      return f ? mark(f.createdAt, f.createdBy) : { done: false }
    }
    default: return mark(b.steps[step.id]?.at, b.steps[step.id]?.by)
  }
}

/** Index of the furthest step a company has completed (-1 = not started). */
export function furthestStep(b: Bidder, steps: WorkflowStep[], files: FileMeta[]): number {
  let idx = -1
  steps.forEach((s, i) => {
    if (stepState(b, s, files).done) idx = i
  })
  return idx
}

export interface JobAlternate {
  id: string
  name: string
  accepted: boolean
}

export type TradeStatus =
  | 'auto'
  | 'not_started'
  | 'out_to_bid'
  | 'following_up'
  | 'pricing'
  | 'covered'
  | 'not_needed'

export interface Trade {
  id: string
  jobId: string
  name: string
  csiCode: string
  status: TradeStatus
  notes: string
  sortOrder: number
  /** Overrides of the job's links when this trade has its own drawing package. */
  drawingsLink: string
  specsLink: string
  /** Trade-specific text for templates ({{trade_scope}}). */
  scopeNote: string
  /** Scope checklist used for bid leveling. */
  scopeItems: string[]
  /** Quantities from the Leopard takeoff for this trade ({{takeoff_quantities}}). */
  takeoffLines: TradeTakeoffLine[]
  createdAt: string
  updatedAt: string
}

export interface Bidder {
  id: string
  jobId: string
  tradeId: string
  companyId: string | null
  companyName: string
  contactName: string
  email: string
  phone: string
  drawingsSentAt: string | null
  lastFollowUpAt: string | null
  followUpCount: number
  priceReceivedAt: string | null
  priceAmount: number | null
  declinedAt: string | null
  /** The company confirmed it will submit a price. */
  willBidAt: string | null
  notes: string
  // ---- bid leveling ----
  inclusions: string
  exclusions: string
  quoteNotes: string
  /** Price per job alternate id. */
  alternatePrices: Record<string, number | null>
  /** Scope checklist item -> included / excluded (with a plug amount to add when excluded). */
  scope: Record<string, ScopeMark>
  /** Custom workflow step id (and 'filed') -> who ticked it and when. */
  steps: Record<string, StepMark>
  /** Latest activity per built-in step (drawings_sent, follow_up, will_bid, price_received): who and when. Filled by getJob. */
  stepLog: Record<string, StepMark>
  // ---- addenda (filled by getJob) ----
  /** Addendum id -> date/time it was sent to this company. */
  addendaSent: Record<string, string>
  /** Addendum id -> date/time the company acknowledged it. */
  addendaAck: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface ScopeMark {
  status: 'included' | 'excluded' | 'unknown'
  plug: number | null
}

export interface Addendum {
  id: string
  jobId: string
  number: string
  title: string
  issuedAt: string | null
  link: string
  description: string
  createdAt: string
}

export interface FileMeta {
  id: string
  jobId: string
  bidderId: string | null
  name: string
  contentType: string
  size: number
  createdAt: string
  createdBy: string
}

export interface AuditEntry {
  id: string
  at: string
  userName: string
  method: string
  summary: string
  jobId: string | null
}

export interface TeamUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'member'
  active: boolean
  createdAt: string
  lastLoginAt: string | null
}

export type BidderStage = 'not_contacted' | 'drawings_sent' | 'followed_up' | 'will_bid' | 'priced' | 'declined'

export type ActivityType =
  | 'drawings_sent'
  | 'follow_up_call'
  | 'follow_up_email'
  | 'price_received'
  | 'declined'
  | 'will_bid'
  | 'addendum_sent'
  | 'addendum_ack'
  | 'step'
  | 'note'
  | 'cleared'

export interface Activity {
  id: string
  jobId: string
  tradeId: string | null
  bidderId: string | null
  type: ActivityType
  note: string
  amount: number | null
  at: string
  userName: string
}

export interface Company {
  id: string
  name: string
  contactName: string
  email: string
  phone: string
  trades: string // comma separated list
  notes: string
  // ---- prequalification ----
  glExpires: string | null // general liability insurance expiration (ISO date)
  wcExpires: string | null // workers' comp expiration
  bondingLimit: number | null
  union: '' | 'union' | 'non_union' | 'both'
  certifications: string // comma separated: MBE, WBE, DBE, SBE, VBE, HUB...
  license: string
  prequalified: boolean
  createdAt: string
  updatedAt: string
}

/** Company with bidding history across all jobs (for "do they actually bid?"). */
export interface CompanyWithStats extends Company {
  invitedCount: number
  pricedCount: number
  declinedCount: number
  lastInvitedAt: string | null
}

export interface Template {
  id: string
  name: string
  kind: 'invite' | 'followup' | 'addendum' | 'other'
  subject: string
  body: string // HTML with {{merge_fields}}
  updatedAt: string
}

export interface TradeWithBidders extends Trade {
  bidders: Bidder[]
}

export interface JobDetail {
  job: Job
  trades: TradeWithBidders[]
  addenda: Addendum[]
  files: FileMeta[]
  milestones: Milestone[]
}

/** Something assigned to a person: the job's takeoff, or a milestone. */
export interface TodayTask {
  kind: 'takeoff' | 'milestone'
  id: string
  jobId: string
  jobName: string
  title: string
  owner: string
  dueAt: string | null
  status: string
}

export interface TodayFollowUp {
  bidderId: string
  companyName: string
  contactName: string
  email: string
  phone: string
  tradeName: string
  jobId: string
  jobName: string
  bidDue: string | null
  lastContactAt: string
  daysSince: number
  followUpCount: number
  willBid: boolean
}

export interface TodayShortTrade {
  jobId: string
  jobName: string
  bidDue: string | null
  tradeId: string
  tradeName: string
  priced: number
  willBid: number
  invited: number
  companies: number
}

export interface TodayAddendum {
  jobId: string
  jobName: string
  addendumId: string
  number: string
  title: string
  notSent: number
  notAcknowledged: number
}

export interface TodaySummary {
  followUps: TodayFollowUp[]
  shortTrades: TodayShortTrade[]
  dueSoon: JobSummary[]
  addenda: TodayAddendum[]
  tasks: TodayTask[]
  generatedAt: string
}

export interface JobSummary extends Job {
  tradeCount: number
  tradesCovered: number
  bidderCount: number
  invitedCount: number
  pricedCount: number
}

export interface EmailMatch {
  email: string
  bidderId: string
  companyName: string
  tradeName: string
  tradeId: string
  jobId: string
  jobName: string
}

export type BidderAction =
  | 'drawings_sent'
  | 'follow_up_call'
  | 'follow_up_email'
  | 'price_received'
  | 'declined'
  | 'will_bid'
  | 'clear_will_bid'
  | 'clear_drawings_sent'
  | 'clear_follow_up'
  | 'clear_price'
  | 'clear_declined'

export interface BidderActionInput {
  at?: string
  note?: string
  amount?: number | null
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  bidding: 'Bidding',
  submitted: 'Submitted',
  won: 'Won',
  lost: 'Lost',
  archived: 'Archived'
}

export const TRADE_STATUS_LABELS: Record<TradeStatus, string> = {
  auto: 'Auto',
  not_started: 'Not Started',
  out_to_bid: 'Out to Bid',
  following_up: 'Following Up',
  pricing: 'Pricing In',
  covered: 'Covered',
  not_needed: 'Not Needed'
}

export const BIDDER_STAGE_LABELS: Record<BidderStage, string> = {
  not_contacted: 'Not Contacted',
  drawings_sent: 'Drawings Sent',
  followed_up: 'Followed Up',
  will_bid: 'Will Bid',
  priced: 'Price Received',
  declined: 'Not Bidding'
}

export function bidderStage(b: Bidder): BidderStage {
  if (b.priceReceivedAt) return 'priced'
  if (b.declinedAt) return 'declined'
  if (b.willBidAt) return 'will_bid'
  if (b.lastFollowUpAt) return 'followed_up'
  if (b.drawingsSentAt) return 'drawings_sent'
  return 'not_contacted'
}

/** Resolves the effective status of a trade: manual choice wins, otherwise derived from its bidders. */
export function effectiveTradeStatus(t: TradeWithBidders): Exclude<TradeStatus, 'auto'> {
  if (t.status !== 'auto') return t.status
  const priced = t.bidders.filter((b) => b.priceReceivedAt).length
  if (priced >= 3) return 'covered'
  if (priced > 0) return 'pricing'
  if (t.bidders.some((b) => b.lastFollowUpAt || b.willBidAt)) return 'following_up'
  if (t.bidders.some((b) => b.drawingsSentAt)) return 'out_to_bid'
  return 'not_started'
}

/** Standard trade list (CSI MasterFormat divisions/sections commonly bid by subcontractors). */
export const STANDARD_TRADES: { csi: string; name: string }[] = [
  { csi: '02 41 00', name: 'Demolition' },
  { csi: '03 30 00', name: 'Cast-in-Place Concrete' },
  { csi: '03 40 00', name: 'Precast Concrete' },
  { csi: '04 20 00', name: 'Masonry' },
  { csi: '05 12 00', name: 'Structural Steel' },
  { csi: '05 50 00', name: 'Misc. Metals' },
  { csi: '06 10 00', name: 'Rough Carpentry' },
  { csi: '06 40 00', name: 'Architectural Millwork' },
  { csi: '07 10 00', name: 'Waterproofing' },
  { csi: '07 21 00', name: 'Insulation' },
  { csi: '07 50 00', name: 'Roofing' },
  { csi: '07 62 00', name: 'Sheet Metal & Flashing' },
  { csi: '07 92 00', name: 'Joint Sealants' },
  { csi: '08 11 00', name: 'Doors, Frames & Hardware' },
  { csi: '08 41 00', name: 'Storefront & Curtain Wall' },
  { csi: '08 80 00', name: 'Glass & Glazing' },
  { csi: '09 21 00', name: 'Drywall & Framing' },
  { csi: '09 30 00', name: 'Tile' },
  { csi: '09 51 00', name: 'Acoustical Ceilings' },
  { csi: '09 65 00', name: 'Resilient Flooring' },
  { csi: '09 68 00', name: 'Carpet' },
  { csi: '09 91 00', name: 'Painting' },
  { csi: '10 14 00', name: 'Signage' },
  { csi: '10 21 00', name: 'Toilet Partitions & Accessories' },
  { csi: '11 40 00', name: 'Food Service Equipment' },
  { csi: '12 24 00', name: 'Window Treatments' },
  { csi: '12 36 00', name: 'Countertops' },
  { csi: '14 20 00', name: 'Elevators' },
  { csi: '21 10 00', name: 'Fire Sprinklers' },
  { csi: '22 00 00', name: 'Plumbing' },
  { csi: '23 00 00', name: 'HVAC' },
  { csi: '26 00 00', name: 'Electrical' },
  { csi: '27 00 00', name: 'Low Voltage / Communications' },
  { csi: '28 31 00', name: 'Fire Alarm' },
  { csi: '31 00 00', name: 'Earthwork & Sitework' },
  { csi: '32 12 00', name: 'Asphalt Paving' },
  { csi: '32 31 00', name: 'Fencing' },
  { csi: '32 90 00', name: 'Landscaping' },
  { csi: '33 00 00', name: 'Site Utilities' }
]

/** Fills {{field}} and {{field|fallback}} placeholders. Values are HTML-escaped unless `raw` is set. */
export function fillTemplate(text: string, fields: Record<string, string>, html = true): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_m, key: string, fallback?: string) => {
    const v = fields[key.toLowerCase()]
    const value = v && v.trim() ? v : (fallback ?? '').trim()
    if (!html) return value
    if (key.toLowerCase() === 'takeoff_quantities') return escapeHtml(value).replace(/\n/g, '<br>')
    if (key.toLowerCase().endsWith('_link') && v && /^(https?:\/\/|www\.)/i.test(value)) {
      const safe = escapeHtml(value)
      const href = /^www\./i.test(value) ? 'https://' + safe : safe
      return `<a href="${href}">${safe}</a>`
    }
    return escapeHtml(value)
  })
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const MERGE_FIELDS: { key: string; label: string }[] = [
  { key: 'first_name', label: 'Contact first name' },
  { key: 'contact_name', label: 'Contact full name' },
  { key: 'company', label: 'Company' },
  { key: 'trade', label: 'Trade' },
  { key: 'job_name', label: 'Job name' },
  { key: 'job_number', label: 'Job number' },
  { key: 'job_location', label: 'Job location' },
  { key: 'client', label: 'Client / Owner' },
  { key: 'bid_due', label: 'Bid due (date & time)' },
  { key: 'drawings_link', label: 'Drawings link' },
  { key: 'specs_link', label: 'Spec book link' },
  { key: 'trade_scope', label: 'Trade scope note' },
  { key: 'takeoff_quantities', label: 'Takeoff quantities for the trade' },
  { key: 'addendum_number', label: 'Addendum number' },
  { key: 'addendum_title', label: 'Addendum title' },
  { key: 'addendum_link', label: 'Addendum link' },
  { key: 'addendum_description', label: 'Addendum description' },
  { key: 'my_name', label: 'My name' },
  { key: 'my_company', label: 'My company' }
]

/** Leveled price: base bid + plugs for excluded scope + accepted alternates. null when there is no base price. */
export function leveledTotal(b: Bidder, t: Trade, job: Job): number | null {
  if (b.priceAmount == null) return null
  let total = b.priceAmount
  for (const item of t.scopeItems) {
    const m = b.scope[item]
    if (m?.status === 'excluded' && m.plug != null) total += m.plug
  }
  for (const alt of job.alternates) if (alt.accepted) total += b.alternatePrices[alt.id] ?? 0
  return total
}

/** True when an expiration date has passed or falls within `days` days. */
export function expiresSoon(iso: string | null, days = 30): 'expired' | 'soon' | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (isNaN(ms)) return null
  if (ms < 0) return 'expired'
  return ms < days * 86400000 ? 'soon' : null
}

export const DEFAULT_TEMPLATES: Omit<Template, 'id' | 'updatedAt'>[] = [
  {
    name: 'Bid Invitation',
    kind: 'invite',
    subject: 'Invitation to Bid: {{job_name}} - {{trade}}',
    body:
      '<p>Hi {{first_name|there}},</p>' +
      '<p>{{my_company}} is bidding <b>{{job_name}}</b> and we would like {{company}} to provide pricing for <b>{{trade}}</b>.</p>' +
      '<p><b>Bids are due: {{bid_due|TBD}}</b></p>' +
      '<p>Drawings: {{drawings_link}}<br>Specifications: {{specs_link}}</p>' +
      '<p>Please reply to confirm whether you will be bidding. Let me know if you have any questions.</p>' +
      '<p>Thank you,</p>'
  },
  {
    name: 'Bid Follow-Up',
    kind: 'followup',
    subject: 'Follow-Up: {{job_name}} - {{trade}} Pricing',
    body:
      '<p>Hi {{first_name|there}},</p>' +
      '<p>Following up on our invitation to bid <b>{{job_name}}</b> for <b>{{trade}}</b>. Bids are due <b>{{bid_due|soon}}</b>.</p>' +
      '<p>Are you planning to submit a price? Here are the documents again:<br>Drawings: {{drawings_link}}<br>Specifications: {{specs_link}}</p>' +
      '<p>Thank you,</p>'
  }
]
export const ADDENDUM_TEMPLATE: Omit<Template, 'id' | 'updatedAt'> = {
  name: 'Addendum Notice',
  kind: 'addendum',
  subject: '{{job_name}} - Addendum {{addendum_number}} Issued',
  body:
    '<p>Hi {{first_name|there}},</p>' +
    '<p><b>Addendum {{addendum_number}}</b> has been issued for <b>{{job_name}}</b>: {{addendum_title}}</p>' +
    '<p>{{addendum_description}}</p>' +
    '<p>Addendum: {{addendum_link}}<br>Drawings: {{drawings_link}}<br>Specifications: {{specs_link}}</p>' +
    '<p>Please include it in your {{trade}} price and reply to confirm you received it. Bids are still due <b>{{bid_due|as scheduled}}</b>.</p>' +
    '<p>Thank you,</p>'
}