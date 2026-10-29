// Today: everything across open jobs that needs attention - follow-ups due, trades short on prices,
// bids due this week, and addenda that haven't reached every bidder.
import { useState } from 'react'
import type { TodayFollowUp } from '../../../shared/types'
import { bid } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Field } from '../components/ui'
import { cx, dueInfo, fmtDateTime, fmtFullDate } from '../util'

export function TodayView() {
  const { today, go, toast, compose, settings, updateSettings } = useApp()
  const [done, setDone] = useState<Set<string>>(new Set())
  if (!today) return <div className="page"><Empty icon="clock" title="Loading..." /></div>

  const act = async (f: TodayFollowUp, action: 'follow_up_call' | 'will_bid' | 'declined') => {
    try {
      await bid.bidderAction(f.bidderId, action)
      setDone((s) => new Set(s).add(f.bidderId))
      toast(`${f.companyName}: ${action === 'follow_up_call' ? 'call logged' : action === 'will_bid' ? 'will bid' : 'not bidding'}`, 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  const email = (f: TodayFollowUp) =>
    compose({
      to: f.contactName ? `${f.contactName.replace(/[,;"<>]/g, '')} <${f.email.split(/[;,\s]+/)[0]}>` : f.email,
      heading: `Follow up with ${f.companyName}`,
      merge: { jobId: f.jobId, bidderId: f.bidderId },
      bidderAction: { bidderId: f.bidderId, action: 'follow_up_email' }
    })

  const followUps = today.followUps.filter((f) => !done.has(f.bidderId))
  const byJob = new Map<string, TodayFollowUp[]>()
  for (const f of followUps) byJob.set(f.jobId, [...(byJob.get(f.jobId) ?? []), f])
  const nothing = !followUps.length && !today.shortTrades.length && !today.dueSoon.length && !today.addenda.length

  return (
    <div className="page today-page">
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <div className="muted">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · follow up with companies not heard from in{' '}
            <select
              className="inline-select"
              value={settings.reminders.followUpDays}
              onChange={(e) => updateSettings({ reminders: { ...settings.reminders, followUpDays: Number(e.target.value) } })}
            >
              {[1, 2, 3, 4, 5, 7, 10].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
            </select>
          </div>
        </div>
      </div>

      {nothing && <Empty icon="check" title="You're all caught up">No follow-ups due, every trade has prices coming, and every addendum has gone out.</Empty>}

      {today.dueSoon.length > 0 && (
        <section className="today-section">
          <h2><Icon name="calendar" /> Bids due this week</h2>
          <div className="today-due">
            {today.dueSoon.map((j) => {
              const d = dueInfo(j.bidDue)
              return (
                <button key={j.id} className={cx('due-card', `tone-${d.tone}`)} onClick={() => go({ kind: 'job', jobId: j.id })}>
                  <b>{j.name}</b>
                  <span>{fmtFullDate(j.bidDue)}</span>
                  <span className="due-label">{d.label}</span>
                  <span className="muted small">{j.pricedCount} prices in · {j.tradesCovered}/{j.tradeCount} trades covered</span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {followUps.length > 0 && (
        <section className="today-section">
          <h2><Icon name="phone" /> Follow-ups due <span className="count-pill">{followUps.length}</span></h2>
          {[...byJob.entries()].map(([jobId, list]) => (
            <div key={jobId} className="today-job">
              <div className="today-job-head">
                <button className="link-strong" onClick={() => go({ kind: 'job', jobId })}>{list[0].jobName}</button>
                {list[0].bidDue && <span className="muted small">bids due {fmtDateTime(list[0].bidDue)}</span>}
              </div>
              <table className="data-table compact">
                <tbody>
                  {list.map((f) => (
                    <tr key={f.bidderId}>
                      <td>
                        <b>{f.companyName}</b> {f.willBid && <span className="stage sm st-will_bid">Will Bid</span>}
                        <div className="muted small">{f.tradeName}{f.contactName ? ` · ${f.contactName}` : ''}</div>
                      </td>
                      <td className="nowrap">{f.phone ? <a href={`tel:${f.phone}`}>{f.phone}</a> : <span className="muted">no phone</span>}</td>
                      <td className="muted small nowrap">
                        last contact {fmtDateTime(f.lastContactAt)} ({f.daysSince === 0 ? 'today' : `${f.daysSince} day${f.daysSince === 1 ? '' : 's'} ago`})
                        {f.followUpCount > 0 && ` · ${f.followUpCount} follow-up${f.followUpCount === 1 ? '' : 's'}`}
                      </td>
                      <td className="row-actions">
                        <Button small icon="phone" kind="primary" onClick={() => act(f, 'follow_up_call')}>Called</Button>
                        <Button small icon="mail" disabled={!f.email} onClick={() => email(f)}>Email</Button>
                        {!f.willBid && <Button small onClick={() => act(f, 'will_bid')}>Will Bid</Button>}
                        <Button small onClick={() => act(f, 'declined')}>Not Bidding</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      )}

      {today.shortTrades.length > 0 && (
        <section className="today-section">
          <h2><Icon name="alert" /> Trades short on prices <span className="count-pill">{today.shortTrades.length}</span></h2>
          <p className="muted small">Fewer than 3 prices in. Consider inviting more companies.</p>
          <table className="data-table compact">
            <thead><tr><th>Job</th><th>Trade</th><th>Prices in</th><th>Will bid</th><th>Invited</th><th /></tr></thead>
            <tbody>
              {today.shortTrades.map((t) => (
                <tr key={t.tradeId}>
                  <td>{t.jobName}{t.bidDue && <div className="muted small">due {fmtDateTime(t.bidDue)}</div>}</td>
                  <td><b>{t.tradeName}</b></td>
                  <td className={t.priced === 0 ? 'err' : ''}>{t.priced}</td>
                  <td>{t.willBid}</td>
                  <td>{t.invited} of {t.companies}</td>
                  <td className="row-actions"><Button small onClick={() => go({ kind: 'job', jobId: t.jobId })}>Open job</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {today.addenda.length > 0 && (
        <section className="today-section">
          <h2><Icon name="file" /> Addenda</h2>
          <table className="data-table compact">
            <tbody>
              {today.addenda.map((a) => (
                <tr key={a.addendumId}>
                  <td>{a.jobName}</td>
                  <td><b>Addendum {a.number}</b> {a.title}</td>
                  <td>{a.notSent > 0 ? <span className="err">{a.notSent} invited compan{a.notSent === 1 ? 'y has' : 'ies have'} not received it</span> : <span className="muted">sent to everyone</span>}</td>
                  <td className="muted">{a.notAcknowledged > 0 ? `${a.notAcknowledged} not acknowledged` : ''}</td>
                  <td className="row-actions"><Button small kind={a.notSent ? 'primary' : 'default'} onClick={() => go({ kind: 'job', jobId: a.jobId, tab: 'addenda' })}>{a.notSent ? 'Send' : 'Open'}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="today-section reminder-settings">
        <h2><Icon name="clock" /> Morning reminder</h2>
        <div className="form-grid narrow">
          <label className="check">
            <input type="checkbox" checked={settings.reminders.enabled} onChange={(e) => updateSettings({ reminders: { ...settings.reminders, enabled: e.target.checked } })} />
            Show a notification each morning with what's due
          </label>
          <Field label="After">
            <select value={settings.reminders.hour} onChange={(e) => updateSettings({ reminders: { ...settings.reminders, hour: Number(e.target.value) } })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{new Date(2000, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' })}</option>)}
            </select>
          </Field>
        </div>
      </section>
    </div>
  )
}