// Morning reminder: once a day (after the chosen hour) a notification says what needs attention today.
import type { TodaySummary } from '../shared/types'
import type { ReminderSettings } from '../shared/ipc'

export const DEFAULT_REMINDERS: ReminderSettings = { enabled: true, hour: 7, followUpDays: 3, lastNotified: '' }

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** One-line summary for the notification, or '' when nothing needs attention. */
export function reminderText(t: TodaySummary): string {
  const parts: string[] = []
  if (t.followUps.length) parts.push(`${t.followUps.length} follow-up${t.followUps.length === 1 ? '' : 's'} due`)
  if (t.shortTrades.length) parts.push(`${t.shortTrades.length} trade${t.shortTrades.length === 1 ? '' : 's'} short on prices`)
  if (t.dueSoon.length) parts.push(`${t.dueSoon.length} bid${t.dueSoon.length === 1 ? '' : 's'} due this week`)
  const notSent = t.addenda.reduce((s, a) => s + (a.notSent ? 1 : 0), 0)
  if (notSent) parts.push(`${notSent} addend${notSent === 1 ? 'um' : 'a'} not sent to everyone`)
  return parts.join(', ')
}

export function startReminders(o: {
  get: () => ReminderSettings
  markNotified: (day: string) => void
  summary: (days: number) => Promise<TodaySummary>
  notify: (title: string, body: string) => void
}) {
  const check = async () => {
    const s = o.get()
    const nowD = new Date()
    if (!s.enabled || nowD.getHours() < s.hour || s.lastNotified === localDay(nowD)) return
    try {
      const text = reminderText(await o.summary(s.followUpDays))
      o.markNotified(localDay(nowD))
      if (text) o.notify('Today in BidMail', text)
    } catch {
      /* team server offline: try again later */
    }
  }
  const timer = setInterval(check, 10 * 60000)
  setTimeout(check, 15000)
  return () => clearInterval(timer)
}