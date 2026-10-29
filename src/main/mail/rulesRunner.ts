// Applies mail rules to new Inbox messages (and on demand to the whole Inbox).
import { readJson, writeJson } from '../jsonFile'
import { MailRule, planRules, RulePlanItem } from '../../shared/rules'
import type { MessageSummary } from '../../shared/ipc'
import type { MailService } from './service'

export class RulesRunner {
  constructor(private mail: MailService, private file: string) {}

  list(): MailRule[] {
    return readJson<MailRule[]>(this.file, [])
  }

  save(rules: MailRule[]) {
    writeJson(this.file, rules)
    return rules
  }

  /** Runs the rules on these messages. Returns the plan that was applied. */
  async apply(accountId: string, folder: string, msgs: MessageSummary[]): Promise<RulePlanItem[]> {
    const plan = planRules(this.list(), accountId, msgs)
    if (!plan.length) return plan
    const read = plan.filter((p) => p.markRead).map((p) => p.uid)
    const flag = plan.filter((p) => p.flag).map((p) => p.uid)
    if (read.length) await this.mail.setFlags(accountId, folder, read, { seen: true }).catch(() => {})
    if (flag.length) await this.mail.setFlags(accountId, folder, flag, { flagged: true }).catch(() => {})
    const byDest = new Map<string, number[]>()
    for (const p of plan) if (p.moveTo && p.moveTo !== folder) byDest.set(p.moveTo, [...(byDest.get(p.moveTo) ?? []), p.uid])
    for (const [dest, uids] of byDest) await this.mail.move(accountId, folder, uids, dest).catch(() => {})
    return plan
  }

  /** "Run rules now": applies them to the newest 300 messages in the Inbox. */
  async runOnInbox(accountId: string): Promise<number> {
    const list = await this.mail.listMessages(accountId, 'INBOX', 0, 300)
    const plan = await this.apply(accountId, 'INBOX', list.messages)
    return plan.length
  }
}