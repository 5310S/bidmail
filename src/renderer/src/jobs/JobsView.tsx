import { useMemo, useState } from 'react'
import { JobStatus, JOB_STATUS_LABELS, TAKEOFF_STATUS_LABELS } from '../../../shared/types'
import { bid } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty } from '../components/ui'
import { cx, dueInfo, fmtFullDate } from '../util'
import { JobForm } from './JobForm'

export function JobsView() {
  const { jobs, go, toast } = useApp()
  const [filter, setFilter] = useState<JobStatus | 'all' | 'open'>('open')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return jobs.filter((j) => {
      if (filter === 'open' && !(j.status === 'bidding' || j.status === 'submitted')) return false
      if (filter !== 'open' && filter !== 'all' && j.status !== filter) return false
      if (s && ![j.name, j.number, j.client, j.location].some((v) => v.toLowerCase().includes(s))) return false
      return true
    })
  }, [jobs, filter, q])

  const upcoming = jobs.filter((j) => j.status === 'bidding' && j.bidDue && new Date(j.bidDue).getTime() > Date.now())
  const thisWeek = upcoming.filter((j) => new Date(j.bidDue!).getTime() - Date.now() < 7 * 86400000)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <div className="muted">
            {jobs.filter((j) => j.status === 'bidding').length} bidding · {thisWeek.length} due in the next 7 days
          </div>
        </div>
        <span className="grow" />
        <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>New Job</Button>
      </div>

      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search jobs" />
        </div>
        <div className="filter-chips">
          {(['open', 'bidding', 'submitted', 'won', 'lost', 'archived', 'all'] as const).map((f) => (
            <button key={f} className={cx('chip', filter === f && 'on')} onClick={() => setFilter(f)}>
              {f === 'open' ? 'Open' : f === 'all' ? 'All' : JOB_STATUS_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <Empty icon="briefcase" title={jobs.length ? 'No jobs match' : 'No jobs yet'}>
          {!jobs.length && (
            <>
              <p>Create a job for each project you're bidding. Add the trades, the companies you're inviting, and track every invite, follow-up and price.</p>
              <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>Create your first job</Button>
            </>
          )}
        </Empty>
      ) : (
        <div className="job-cards">
          {list.map((j) => {
            const due = dueInfo(j.bidDue)
            const pct = j.tradeCount ? Math.round((j.tradesCovered / j.tradeCount) * 100) : 0
            return (
              <div key={j.id} className="job-card" onClick={() => go({ kind: 'job', jobId: j.id })}>
                <div className="job-card-top">
                  <div className="grow">
                    <div className="job-card-name">{j.name}</div>
                    <div className="muted">
                      {[j.number, j.client, j.location].filter(Boolean).join(' · ') || '\u00a0'}
                    </div>
                  </div>
                  <select
                    className={cx('status-select', `js-${j.status}`)}
                    value={j.status}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => bid.updateJob(j.id, { status: e.target.value as JobStatus }).catch((er) => toast(er.message, 'error'))}
                  >
                    {Object.entries(JOB_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div className={cx('due', `tone-${due.tone}`)}>
                  <Icon name="calendar" size={15} />
                  <span>{j.bidDue ? fmtFullDate(j.bidDue) : 'No bid date set'}</span>
                  {j.bidDue && j.status === 'bidding' && <b>{due.label}</b>}
                </div>
                <div className="progress-row">
                  <div className="progress"><div style={{ width: pct + '%' }} /></div>
                  <span>{j.tradesCovered}/{j.tradeCount} trades covered</span>
                </div>
                <div className={cx('job-takeoff', `tk-${j.takeoff.status}`)}>
                  <Icon name="edit" size={14} /> Takeoff: {j.takeoff.assignee || <i>unassigned</i>} · {TAKEOFF_STATUS_LABELS[j.takeoff.status]}
                </div>
                <div className="job-card-stats">
                  <span><b>{j.bidderCount}</b> companies</span>
                  <span><b>{j.invitedCount}</b> invited</span>
                  <span><b>{j.pricedCount}</b> prices in</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {creating && <JobForm onClose={() => setCreating(false)} onSaved={(j) => go({ kind: 'job', jobId: j.id })} />}
    </div>
  )
}