// Groups messages into conversations using Message-ID / In-Reply-To, with a subject fallback.
import type { MessageSummary } from './ipc'

export interface Conversation {
  key: string
  messages: MessageSummary[] // newest first
  latest: MessageSummary
  unread: number
  flagged: boolean
  hasAttachments: boolean
}

export function normalizeSubject(s: string): string {
  return (s || '')
    .replace(/^\s*((re|fw|fwd|aw|wg|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const GENERIC = new Set(['', '(no subject)', 'no subject', 'hello', 'hi', 'question', 'quote', 'pricing', 'bid'])

/** Returns conversations, newest first. Messages with no relatives become a conversation of one. */
export function threadMessages(msgs: MessageSummary[]): Conversation[] {
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let r = x
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const m of msgs) parent.set(m.uid, m.uid)
  const byId = new Map<string, number>()
  for (const m of msgs) if (m.messageId) byId.set(m.messageId, m.uid)
  for (const m of msgs) {
    const p = m.inReplyTo && byId.get(m.inReplyTo)
    if (p) union(m.uid, p)
  }
  // Subject fallback: same specific subject within 45 days counts as one conversation.
  const bySubject = new Map<string, MessageSummary[]>()
  for (const m of msgs) {
    const s = normalizeSubject(m.subject)
    if (GENERIC.has(s) || s.length < 6) continue
    bySubject.set(s, [...(bySubject.get(s) ?? []), m])
  }
  for (const group of bySubject.values()) {
    for (let i = 1; i < group.length; i++) {
      const gap = Math.abs(new Date(group[i].date).getTime() - new Date(group[0].date).getTime())
      if (gap < 45 * 86400000) union(group[i].uid, group[0].uid)
    }
  }
  const groups = new Map<number, MessageSummary[]>()
  for (const m of msgs) {
    const r = find(m.uid)
    groups.set(r, [...(groups.get(r) ?? []), m])
  }
  const convs: Conversation[] = []
  for (const [root, list] of groups) {
    list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime() || b.uid - a.uid)
    convs.push({
      key: 'c' + root,
      messages: list,
      latest: list[0],
      unread: list.filter((m) => !m.seen).length,
      flagged: list.some((m) => m.flagged),
      hasAttachments: list.some((m) => m.hasAttachments)
    })
  }
  return convs.sort((a, b) => new Date(b.latest.date).getTime() - new Date(a.latest.date).getTime() || b.latest.uid - a.latest.uid)
}