// Sends one personalized email per company (bid invitations / follow-ups) and records the
// status checkpoint with date & time on each company as it goes.
import { randomUUID } from 'node:crypto'
import { BulkProgress, BulkSendInput } from '../shared/ipc'
import { fillTemplate, JobDetail } from '../shared/types'
import { mergeFields, signOff } from '../shared/merge'
import { MailService } from './mail/service'
import { BidBackend } from './bidBackend'
import { getAccount } from './mail/accounts'
import { getSettings } from './settings'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class BulkSender {
  private cancelled = new Set<string>()

  constructor(
    private mail: MailService,
    private bid: BidBackend,
    private emit: (p: BulkProgress) => void
  ) {}

  cancel(runId: string) {
    this.cancelled.add(runId)
  }

  async start(input: BulkSendInput): Promise<string> {
    const runId = randomUUID()
    const detail: JobDetail | null = await this.bid.call('getJob', [input.jobId])
    if (!detail) throw new Error('Job not found')
    const acct = getAccount(input.accountId)
    if (!acct) throw new Error('Choose an email account to send from.')
    if (input.markAs === 'addendum' && !detail.addenda.some((a) => a.id === input.addendumId)) throw new Error('Addendum not found')
    this.run(runId, input, detail, acct.account.signature).catch(() => {})
    return runId
  }

  private async run(runId: string, input: BulkSendInput, detail: JobDetail, signature: string) {
    const settings = getSettings()
    const me = { name: settings.userName, company: settings.companyName }
    const lookup = new Map(detail.trades.flatMap((t) => t.bidders.map((b) => [b.id, { trade: t, bidder: b }] as const)))
    const ids = input.bidderIds.filter((id) => lookup.has(id))
    const addendum = input.addendumId ? detail.addenda.find((a) => a.id === input.addendumId) ?? null : null
    if (input.markAs === 'addendum' && !addendum) throw new Error('Addendum not found')
    for (const id of ids) this.emit({ runId, bidderId: id, state: 'queued', done: false })

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const last = i === ids.length - 1
      if (this.cancelled.has(runId)) {
        this.emit({ runId, bidderId: id, state: 'cancelled', done: last })
        continue
      }
      const { trade, bidder } = lookup.get(id)!
      const to = bidder.email.split(/[;,\s]+/).filter((e) => e.includes('@')).join(', ')
      if (!to) {
        this.emit({ runId, bidderId: id, state: 'skipped', error: 'No email address', done: last })
        continue
      }
      this.emit({ runId, bidderId: id, state: 'sending', done: false })
      try {
        const fields = mergeFields(detail.job, trade, bidder, me, addendum)
        const subject = fillTemplate(input.subject, fields, false)
        const sig = signOff(signature, me)
        const body = fillTemplate(input.body, fields, true) + (sig ? `<br>${sig}` : '')
        await this.mail.send({
          accountId: input.accountId,
          to,
          cc: input.cc ?? '',
          bcc: '',
          subject,
          html: body,
          attachments: input.attachments
        })
        if (input.markAs === 'addendum' && addendum) {
          await this.bid.call('markAddendumSent', [addendum.id, [id]]).catch(() => {})
        } else if (input.markAs !== 'none') {
          await this.bid.call('bidderAction', [id, input.markAs, { note: `Emailed: ${subject}` }]).catch(() => {})
        }
        this.emit({ runId, bidderId: id, state: 'sent', done: last })
      } catch (e: any) {
        this.emit({ runId, bidderId: id, state: 'failed', error: e?.message ?? String(e), done: last })
      }
      if (!last) await sleep(Math.max(250, settings.sendDelayMs))
    }
    if (!ids.length) this.emit({ runId, bidderId: '', state: 'skipped', done: true })
    this.cancelled.delete(runId)
  }
}