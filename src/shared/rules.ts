// Mail rules: run on new mail in the Inbox (e.g. move plan-room notices to a folder, flag mail from a GC).
import type { MessageSummary } from './ipc'

export type RuleField = 'from' | 'to' | 'subject' | 'any'
export type RuleOp = 'contains' | 'not_contains' | 'equals' | 'starts_with' | 'ends_with'

export interface RuleCondition {
  field: RuleField
  op: RuleOp
  value: string
}

export interface RuleActions {
  moveTo?: string // folder path on the rule's account
  markRead?: boolean
  flag?: boolean
  /** Don't show a desktop notification for matching mail. */
  silent?: boolean
}

export interface MailRule {
  id: string
  name: string
  enabled: boolean
  accountId: string // '*' = every account (only allowed without moveTo)
  match: 'all' | 'any'
  conditions: RuleCondition[]
  actions: RuleActions
}

export const RULE_FIELD_LABELS: Record<RuleField, string> = { from: 'From', to: 'To / Cc', subject: 'Subject', any: 'From, To or Subject' }
export const RULE_OP_LABELS: Record<RuleOp, string> = {
  contains: 'contains', not_contains: "doesn't contain", equals: 'is', starts_with: 'starts with', ends_with: 'ends with'
}

function values(m: MessageSummary, field: RuleField): string[] {
  const addrs = (l: { name: string; address: string }[]) => l.flatMap((a) => [a.address, a.name].filter(Boolean))
  if (field === 'from') return addrs(m.from)
  if (field === 'to') return addrs([...m.to, ...m.cc])
  if (field === 'subject') return [m.subject]
  return [...addrs(m.from), ...addrs([...m.to, ...m.cc]), m.subject]
}

function test(c: RuleCondition, m: MessageSummary): boolean {
  const needle = c.value.trim().toLowerCase()
  if (!needle) return false
  const vals = values(m, c.field).map((v) => (v ?? '').toLowerCase())
  switch (c.op) {
    case 'contains': return vals.some((v) => v.includes(needle))
    case 'not_contains': return vals.every((v) => !v.includes(needle))
    case 'equals': return vals.some((v) => v === needle)
    case 'starts_with': return vals.some((v) => v.startsWith(needle))
    case 'ends_with': return vals.some((v) => v.endsWith(needle))
  }
}

export function ruleMatches(rule: MailRule, m: MessageSummary): boolean {
  const conds = rule.conditions.filter((c) => c.value.trim())
  if (!rule.enabled || !conds.length) return false
  return rule.match === 'any' ? conds.some((c) => test(c, m)) : conds.every((c) => test(c, m))
}

export interface RulePlanItem {
  uid: number
  ruleIds: string[]
  moveTo?: string
  markRead: boolean
  flag: boolean
  silent: boolean
}

/** Works out what to do with each message. Actions combine; the first rule with a folder decides where it goes. */
export function planRules(rules: MailRule[], accountId: string, msgs: MessageSummary[]): RulePlanItem[] {
  const out: RulePlanItem[] = []
  const applicable = rules.filter((r) => r.enabled && (r.accountId === '*' || r.accountId === accountId))
  for (const m of msgs) {
    const hits = applicable.filter((r) => ruleMatches(r, m))
    if (!hits.length) continue
    out.push({
      uid: m.uid,
      ruleIds: hits.map((r) => r.id),
      moveTo: hits.find((r) => r.actions.moveTo && r.accountId === accountId)?.actions.moveTo,
      markRead: hits.some((r) => r.actions.markRead),
      flag: hits.some((r) => r.actions.flag),
      silent: hits.some((r) => r.actions.silent || !!r.actions.moveTo)
    })
  }
  return out
}