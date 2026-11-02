// Job folders: which emails belong to a job. An email belongs when it is to or from one of the job's companies
// (the address itself, or the company's own web domain, so a reply from a colleague counts), or when its subject
// names the job (its number, or the distinctive words of its name). A company bidding several open jobs is settled
// by the subject; when the subject names none of them, the email shows in each of those jobs.
import type { Address, MessageSummary } from './ipc'
import type { EmailMatch } from './types'

export interface JobRef {
  id: string
  name: string
  number: string
}

/** One email in a job folder: where it lives, and whether it was sent or received. */
export interface JobMailItem extends MessageSummary {
  accountId: string
  folder: string
  sent: boolean
}

export interface JobMailResult {
  messages: JobMailItem[]
  errors: string[]
}

/** Free mail providers: many unrelated companies share these, so only exact addresses match there. */
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'aol.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'verizon.net', 'optonline.net', 'att.net', 'sbcglobal.net', 'optimum.net',
  'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'zoho.com', 'earthlink.net', 'cox.net', 'charter.net', 'bellsouth.net'
])
/** Words too common in job names to tell jobs apart (job names are often the drawing set's title). */
const COMMON = new Set([
  'the', 'and', 'for', 'of', 'at', 'to', 'new', 'job', 'project', 'bid', 'bids', 'phase', 'building', 'renovation', 'renovations',
  'rehab', 'addition', 'alterations', 'repairs', 'replacement', 'improvements', 'school', 'center', 'office', 'street', 'road',
  'avenue', 'drawings', 'drawing', 'conformed', 'set', 'add', 'addendum', 'addenda', 'thru', 'through', 'plans', 'specs',
  'specifications', 'rev', 'revised', 'final', 'issued', 'permit', 'construction', 'documents', 'package'
])

const words = (s: string) => s.toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
const domainOf = (address: string) => address.toLowerCase().split('@')[1] ?? ''

function nameWords(job: JobRef) {
  const all = words(job.name).split(' ').filter((w) => w.length >= 3)
  return { all, key: all.filter((w) => !COMMON.has(w)) }
}

/** Does the subject name this job: its number, or two of the distinctive words of its name (the one, if it has one)? */
export function subjectNames(subject: string, job: JobRef): boolean {
  const s = ` ${words(subject)} `
  const has = (w: string) => s.includes(` ${w} `)
  const num = words(job.number)
  if (num.length >= 3 && has(num)) return true
  const { all, key } = nameWords(job)
  if (!key.length) return all.length >= 2 && all.every(has)
  // "TOBHA Facade" names "TOBHA Facade Rehab"; "TOBHA" alone names "TOBHA - Drawings - Conformed Add 1".
  return key.filter(has).length >= Math.min(2, key.length)
}

/**
 * What to ask the mail server for, to find a job's emails quickly: words of the job's number and name for the
 * subject, and its companies (by web domain, or by address at free mail providers) for the people. The results
 * are then judged by JobMailMatcher, which is stricter.
 */
export function searchTerms(job: JobRef, companyEmails: string[], ownAddresses: string[]): { subjects: string[]; people: string[] } {
  const own = new Set(ownAddresses.map(domainOf))
  const { all, key } = nameWords(job)
  const subjects = [job.number.trim(), ...(key.length ? key : all).slice(0, 5)].filter((w) => w.length >= 3)
  const people = companyEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'))
    .map((e) => (PUBLIC_DOMAINS.has(domainOf(e)) || own.has(domainOf(e)) ? e : domainOf(e)))
  return { subjects: [...new Set(subjects)], people: [...new Set(people)].slice(0, 25) }
}

export class JobMailMatcher {
  private byAddress = new Map<string, Set<string>>()
  private byDomain = new Map<string, Set<string>>()

  constructor(private jobs: JobRef[], index: EmailMatch[], ownAddresses: string[]) {
    const own = new Set(ownAddresses.map(domainOf))
    const add = (m: Map<string, Set<string>>, k: string, jobId: string) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(jobId)
    for (const e of index) {
      const a = e.email.trim().toLowerCase()
      add(this.byAddress, a, e.jobId)
      const d = domainOf(a)
      if (d && !PUBLIC_DOMAINS.has(d) && !own.has(d)) add(this.byDomain, d, e.jobId)
    }
  }

  /** The jobs an email belongs to. Received mail is judged by its sender, sent mail by its recipients. */
  jobsFor(m: { from: Address[]; to: Address[]; cc: Address[]; subject: string }, sent: boolean): string[] {
    const named = this.jobs.filter((j) => subjectNames(m.subject, j)).map((j) => j.id)
    const people = (sent ? [...m.to, ...m.cc] : m.from).map((p) => p.address.toLowerCase()).filter(Boolean)
    const candidates = new Set<string>()
    for (const a of people) {
      for (const id of this.byAddress.get(a) ?? this.byDomain.get(domainOf(a)) ?? []) candidates.add(id)
    }
    if (candidates.size <= 1) return [...new Set([...named, ...candidates])]
    // A company on several jobs: the subject decides; if it names none of them, the email goes with each.
    const settled = [...candidates].filter((id) => named.includes(id))
    return [...new Set([...named, ...(settled.length ? settled : candidates)])]
  }
}
