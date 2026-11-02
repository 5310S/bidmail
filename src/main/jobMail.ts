// Job folders: a job's emails, found by searching every account's Inbox, Sent and Archive for the job's name and
// number in the subject and for its companies' addresses, then judged by JobMailMatcher. Nothing is moved; the
// folders exist only in BidMail. Searching (rather than reading whole folders) keeps Mac Mail accounts quick.
import type { MailService } from './mail/service'
import type { BidBackend } from './bidBackend'
import { listAccounts } from './mail/accounts'
import type { EmailMatch, JobDetail, JobSummary } from '../shared/types'
import { JobMailItem, JobMailMatcher, JobMailResult, searchTerms } from '../shared/jobMail'

export class JobMail {
  constructor(private mail: MailService, private backend: BidBackend) {}

  async forJob(jobId: string): Promise<JobMailResult> {
    const d: JobDetail | null = await this.backend.call('getJob', [jobId])
    if (!d) throw new Error('Job not found')
    const jobs: JobSummary[] = await this.backend.call('listJobs', [])
    const open = jobs.filter((j) => j.status === 'bidding' || j.status === 'submitted' || j.id === jobId)
    // Every open job's companies (to settle companies on several jobs), plus this job's own even when it's closed.
    const index: EmailMatch[] = await this.backend.call('emailIndex', [])
    const mine: string[] = []
    for (const t of d.trades) {
      for (const b of t.bidders) {
        for (const email of b.email.split(/[;,\s]+/).filter((e) => e.includes('@'))) {
          mine.push(email)
          index.push({ email, bidderId: b.id, companyName: b.companyName, tradeName: t.name, tradeId: t.id, jobId, jobName: d.job.name })
        }
      }
    }
    const accounts = listAccounts()
    const own = accounts.map((a) => a.email)
    const matcher = new JobMailMatcher(open.map((j) => ({ id: j.id, name: j.name, number: j.number })), index, own)
    const { subjects, people } = searchTerms({ id: jobId, name: d.job.name, number: d.job.number }, mine, own)

    const out: JobMailItem[] = []
    const errors: string[] = []
    for (const a of accounts) {
      let folders
      try {
        folders = await this.mail.listFolders(a.id)
      } catch (e: any) {
        errors.push(`${a.email}: ${e?.message ?? e}`)
        continue
      }
      const pick = (use: string) => folders.find((f) => f.specialUse === use)
      const scan = [
        { folder: 'INBOX', sent: false },
        ...[pick('\\Sent')].filter(Boolean).map((f) => ({ folder: f!.path, sent: true })),
        ...[pick('\\Archive')].filter(Boolean).map((f) => ({ folder: f!.path, sent: false }))
      ]
      for (const s of scan) {
        try {
          for (const m of await this.mail.findMessages(a.id, s.folder, subjects, people, s.sent)) {
            if (matcher.jobsFor(m, s.sent).includes(jobId)) out.push({ ...m, accountId: a.id, folder: s.folder, sent: s.sent })
          }
        } catch (e: any) {
          errors.push(`${a.email} (${s.folder === 'INBOX' ? 'Inbox' : s.folder}): ${e?.message ?? e}`)
        }
      }
    }
    out.sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime())
    return { messages: out, errors }
  }
}
