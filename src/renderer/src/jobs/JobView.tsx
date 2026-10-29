import { useMemo, useState } from 'react'
import { effectiveTradeStatus, JobDetail, JobStatus, JOB_STATUS_LABELS, STANDARD_TRADES, TRADE_STATUS_LABELS } from '../../../shared/types'
import { bid, sys } from '../api'
import { useApp, useBidQuery } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Field, Menu, Modal, Spinner } from '../components/ui'
import { cx, dueInfo, fmtDateTime, fmtFullDate, fmtMoney } from '../util'
import { JobForm } from './JobForm'
import { ACTIVITY_LABELS, TradeCard } from './TradeCard'
import { BulkSend } from './BulkSend'
import { AddendaTab } from './AddendaTab'
import { LevelingTab } from './LevelingTab'
import { buildJobReport } from './report'
import { buildEventIcs } from '../../../shared/ics'

type Tab = 'trades' | 'addenda' | 'leveling' | 'board' | 'activity'

export function JobView({ jobId, initialTab }: { jobId: string; initialTab?: string }) {
  const { go, toast, confirm, jobs, settings } = useApp()
  const { data: detail, error, loading } = useBidQuery(() => bid.getJob(jobId), [jobId])
  const { data: companyList } = useBidQuery(() => bid.listCompanies(), [])
  const companies = useMemo(() => new Map((companyList ?? []).map((c) => [c.id, c])), [companyList])
  const [tab, setTab] = useState<Tab>((initialTab as Tab) || 'trades')
  const [editing, setEditing] = useState(false)
  const [bulkMode, setBulkMode] = useState<{ mode: 'invite' | 'followup' | 'addendum'; tradeId?: string; addendumId?: string } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [q, setQ] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [addingTrade, setAddingTrade] = useState(false)
  const [copying, setCopying] = useState(false)

  if (loading && !detail) return <div className="page"><Spinner label="Loading job..." /></div>
  if (error) return <div className="page"><Empty icon="alert" title="Couldn't load this job">{error}</Empty></div>
  if (!detail) return <div className="page"><Empty icon="briefcase" title="Job not found"><Button onClick={() => go({ kind: 'jobs' })}>Back to jobs</Button></Empty></div>

  const { job, trades } = detail
  const due = dueInfo(job.bidDue)
  const bidders = trades.flatMap((t) => t.bidders)
  const relevant = trades.filter((t) => effectiveTradeStatus(t) !== 'not_needed')
  const covered = relevant.filter((t) => effectiveTradeStatus(t) === 'covered').length
  const needsFollowUp = bidders.filter((b) => b.drawingsSentAt && !b.priceReceivedAt && !b.declinedAt).length
  const search = q.trim().toLowerCase()
  const shownTrades = trades.filter((t) => {
    if (onlyOpen && ['covered', 'not_needed'].includes(effectiveTradeStatus(t))) return false
    if (!search) return true
    return t.name.toLowerCase().includes(search) || t.bidders.some((b) => [b.companyName, b.contactName, b.email].some((v) => v.toLowerCase().includes(search)))
  })

  const me = { name: settings.userName, company: settings.companyName }

  const addBidDateToCalendar = () => {
    if (!job.bidDue) return
    const lines = [
      job.client && `Client: ${job.client}`,
      job.number && `Job #: ${job.number}`,
      job.drawingsLink && `Drawings: ${job.drawingsLink}`,
      job.specsLink && `Specs: ${job.specsLink}`
    ].filter(Boolean)
    sys
      .openIcs(
        `${job.name} - Bid Due`,
        buildEventIcs({
          uid: `bid-${job.id}@bidmail`,
          summary: `BID DUE: ${job.name}`,
          start: job.bidDue,
          location: job.location,
          description: lines.join('\n'),
          remindMinutesBefore: [24 * 60, 120]
        })
      )
      .catch((e) => toast(e.message, 'error'))
  }

  const exportCsv = async () => {
    try {
      const csv = await bid.exportJobCsv(job.id)
      const p = await sys.saveText(`${job.name.replace(/[\\/:*?"<>|]/g, '')} - Bid Status.csv`, csv)
      if (p) toast('Exported to ' + p, 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="page job-page">
      <div className="job-header">
        <div className="job-title-row">
          <button className="crumb" onClick={() => go({ kind: 'jobs' })}><Icon name="chevronLeft" size={16} /> Jobs</button>
        </div>
        <div className="job-title-row">
          <div className="grow">
            <h1>{job.name}</h1>
            <div className="muted job-sub">
              {[job.number && `#${job.number}`, job.client, job.location].filter(Boolean).join(' · ') || 'Add job details with Edit Job'}
            </div>
          </div>
          <select
            className={cx('status-select big', `js-${job.status}`)}
            value={job.status}
            onChange={(e) => bid.updateJob(job.id, { status: e.target.value as JobStatus }).catch((er) => toast(er.message, 'error'))}
          >
            {Object.entries(JOB_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Button icon="edit" onClick={() => setEditing(true)}>Edit Job</Button>
          <Menu
            align="right"
            trigger={(open) => <Button icon="more" onClick={open} />}
            items={[
              { label: 'Export status to Excel (CSV)', icon: 'download', onClick: exportCsv },
              { label: 'Print bid status', icon: 'printer', onClick: () => sys.print(buildJobReport(detail, me)).catch((e) => toast(e.message, 'error')) },
              {
                label: 'Save bid status as PDF',
                icon: 'file',
                onClick: () =>
                  sys
                    .savePdf(buildJobReport(detail, me), `${job.name} - Bid Status`)
                    .then((p) => p && toast('Saved PDF to ' + p, 'success'))
                    .catch((e) => toast(e.message, 'error'))
              },
              { label: 'Copy trades from another job', icon: 'copy', onClick: () => setCopying(true), disabled: jobs.length < 2 },
              'sep',
              {
                label: 'Delete job',
                icon: 'trash',
                danger: true,
                onClick: async () => {
                  if (await confirm({ title: 'Delete job?', message: <>Delete <b>{job.name}</b> with all its trades, companies and history? This cannot be undone. (Consider setting the status to Archived instead.)</> })) {
                    await bid.deleteJob(job.id)
                    go({ kind: 'jobs' })
                  }
                }
              }
            ]}
          />
        </div>

        <div className="job-facts">
          <div className={cx('fact due', `tone-${due.tone}`)}>
            <Icon name="calendar" />
            <div>
              <div className="fact-label">Bids due</div>
              <div className="fact-value">{job.bidDue ? fmtFullDate(job.bidDue) : 'Not set'}</div>
              {job.bidDue && job.status === 'bidding' && <div className="fact-sub">{due.label}</div>}
              {job.bidDue && (
                <button className="link-btn small" onClick={addBidDateToCalendar} title="Opens in Outlook / Calendar with a reminder the day before">
                  <Icon name="calendar" size={13} /> Add to calendar
                </button>
              )}
            </div>
          </div>
          <div className="fact links">
            <Button icon="external" disabled={!job.drawingsLink} title={job.drawingsLink || 'No drawings link - use Edit Job'} onClick={() => sys.openExternal(job.drawingsLink)}>Drawings</Button>
            <Button icon="external" disabled={!job.specsLink} title={job.specsLink || 'No spec link - use Edit Job'} onClick={() => sys.openExternal(job.specsLink)}>Spec Book</Button>
            {job.folderPath && <Button icon="folder" title={job.folderPath} onClick={() => sys.openPath(job.folderPath).catch((e) => toast(e.message, 'error'))}>Job Folder</Button>}
          </div>
          <div className="fact stats">
            <div><b>{covered}/{relevant.length}</b><span>trades covered</span></div>
            <div><b>{bidders.length}</b><span>companies</span></div>
            <div><b>{bidders.filter((b) => b.drawingsSentAt).length}</b><span>invited</span></div>
            <div><b>{bidders.filter((b) => b.priceReceivedAt).length}</b><span>prices in</span></div>
            <div className={needsFollowUp ? 'attn' : ''}><b>{needsFollowUp}</b><span>awaiting price</span></div>
          </div>
          <div className="fact actions">
            <Button kind="primary" icon="send" onClick={() => setBulkMode({ mode: 'invite' })} disabled={!bidders.length}>Send Drawings</Button>
            <Button icon="phone" onClick={() => setBulkMode({ mode: 'followup' })} disabled={!needsFollowUp}>Follow Up</Button>
          </div>
        </div>
        {(!job.drawingsLink || !job.specsLink) && (
          <div className="warn-box">
            <Icon name="link" size={16} />
            {!job.drawingsLink && !job.specsLink ? 'Add the drawings and spec book links' : !job.drawingsLink ? 'Add the drawings link' : 'Add the spec book link'} so they go out with your bid invitations.
            <button className="link-btn" onClick={() => setEditing(true)}>Edit job</button>
          </div>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades & Companies <span className="count">{trades.length}</span></button>
        <button className={tab === 'addenda' ? 'on' : ''} onClick={() => setTab('addenda')}>Addenda {detail.addenda.length > 0 && <span className="count">{detail.addenda.length}</span>}</button>
        <button className={tab === 'leveling' ? 'on' : ''} onClick={() => setTab('leveling')}>Bid Leveling</button>
        <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>Bid Board</button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
      </div>

      {tab === 'trades' && (
        <>
          <div className="toolbar">
            <Button icon="plus" onClick={() => setAddingTrade(true)}>Add Trades</Button>
            <div className="search-box">
              <Icon name="search" size={16} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a trade or company" />
            </div>
            <label className="check"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Hide covered trades</label>
            <span className="grow" />
            <button className="link-btn" onClick={() => setCollapsed({})}>Expand all</button>
            <button className="link-btn" onClick={() => setCollapsed(Object.fromEntries(trades.map((t) => [t.id, true])))}>Collapse all</button>
          </div>
          {trades.length === 0 && (
            <Empty icon="grid" title="No trades yet">
              <p>Add the trades you need priced, then the companies under each trade.</p>
              <Button kind="primary" icon="plus" onClick={() => setAddingTrade(true)}>Add Trades</Button>
            </Empty>
          )}
          {shownTrades.map((t) => (
            <TradeCard
              key={t.id}
              job={job}
              trade={t}
              trades={trades}
              addenda={detail.addenda}
              files={detail.files}
              companies={companies}
              collapsed={!!collapsed[t.id]}
              onToggle={() => setCollapsed((c) => ({ ...c, [t.id]: !c[t.id] }))}
              onBulk={(tradeId) => setBulkMode({ mode: 'invite', tradeId })}
              highlight={search && !t.name.toLowerCase().includes(search) ? search : ''}
            />
          ))}
        </>
      )}
      {tab === 'addenda' && <AddendaTab detail={detail} onSend={(addendumId) => setBulkMode({ mode: 'addendum', addendumId })} />}
      {tab === 'leveling' && <LevelingTab detail={detail} />}
      {tab === 'board' && <BidBoard detail={detail} />}
      {tab === 'activity' && <ActivityTab detail={detail} />}

      {editing && <JobForm job={job} onClose={() => setEditing(false)} />}
      {bulkMode && <BulkSend detail={detail} mode={bulkMode.mode} tradeId={bulkMode.tradeId} addendumId={bulkMode.addendumId} onClose={() => setBulkMode(null)} />}
      {addingTrade && <AddTradesModal detail={detail} onClose={() => setAddingTrade(false)} />}
      {copying && <CopyTradesModal detail={detail} onClose={() => setCopying(false)} />}
    </div>
  )
}

function AddTradesModal({ detail, onClose }: { detail: JobDetail; onClose: () => void }) {
  const { toast } = useApp()
  const have = new Set(detail.trades.map((t) => t.name.toLowerCase()))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [custom, setCustom] = useState('')
  const [csi, setCsi] = useState('')
  const save = async () => {
    const list = STANDARD_TRADES.filter((t) => picked.has(t.name)).map((t) => ({ name: t.name, csiCode: t.csi }))
    if (custom.trim()) list.push({ name: custom.trim(), csiCode: csi.trim() })
    if (!list.length) return onClose()
    try {
      await bid.addTrades(detail.job.id, list)
      toast(`Added ${list.length} trade${list.length === 1 ? '' : 's'}`, 'success')
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <Modal title="Add trades" onClose={onClose} width={760} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Add</Button></>}>
      <div className="form-grid">
        <Field label="Custom trade name"><input autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Overhead Doors" onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
        <Field label="CSI code (optional)"><input value={csi} onChange={(e) => setCsi(e.target.value)} placeholder="08 36 00" /></Field>
      </div>
      <div className="field-label" style={{ marginTop: 12 }}>Or pick standard trades</div>
      <div className="trade-pick">
        {STANDARD_TRADES.map((t) => {
          const exists = have.has(t.name.toLowerCase())
          return (
            <label key={t.name} className={cx(picked.has(t.name) && 'on', exists && 'disabled')}>
              <input
                type="checkbox"
                disabled={exists}
                checked={picked.has(t.name)}
                onChange={(e) => {
                  const n = new Set(picked)
                  if (e.target.checked) n.add(t.name)
                  else n.delete(t.name)
                  setPicked(n)
                }}
              />
              <span className="muted mono">{t.csi.slice(0, 2)}</span> {t.name} {exists && <span className="muted small">(added)</span>}
            </label>
          )
        })}
      </div>
    </Modal>
  )
}

function CopyTradesModal({ detail, onClose }: { detail: JobDetail; onClose: () => void }) {
  const { jobs, toast } = useApp()
  const others = jobs.filter((j) => j.id !== detail.job.id)
  const [src, setSrc] = useState(others[0]?.id ?? '')
  const [withCompanies, setWithCompanies] = useState(true)
  const save = async () => {
    try {
      await bid.copyTrades(detail.job.id, src, withCompanies)
      toast('Trades copied', 'success')
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <Modal title="Copy trades from another job" onClose={onClose} width={480} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save} disabled={!src}>Copy</Button></>}>
      <Field label="Copy from">
        <select value={src} onChange={(e) => setSrc(e.target.value)}>
          {others.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
      </Field>
      <label className="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={withCompanies} onChange={(e) => setWithCompanies(e.target.checked)} /> Include the companies (statuses start fresh)
      </label>
    </Modal>
  )
}

/** Price comparison per trade: who's priced, low bid, spread, and a running total of low numbers. */
function BidBoard({ detail }: { detail: JobDetail }) {
  const rows = detail.trades.map((t) => {
    const prices = t.bidders.filter((b) => b.priceReceivedAt && b.priceAmount != null).sort((a, b) => a.priceAmount! - b.priceAmount!)
    const low = prices[0]
    const high = prices[prices.length - 1]
    return { t, prices, low, high, status: effectiveTradeStatus(t) }
  })
  const total = rows.reduce((s, r) => s + (r.low?.priceAmount ?? 0), 0)
  const missing = rows.filter((r) => !r.low && r.status !== 'not_needed')
  return (
    <div className="board">
      <div className="board-summary">
        <div><span className="muted">Total of low prices</span><b>{fmtMoney(total) || '$0'}</b></div>
        <div><span className="muted">Trades with no price yet</span><b className={missing.length ? 'err' : ''}>{missing.length}</b></div>
      </div>
      <table className="board-table">
        <thead>
          <tr>
            <th>Trade</th><th>Status</th><th>Invited</th><th>Priced</th><th>Low Bid</th><th>Low Company</th><th>High</th><th>Spread</th><th>All prices</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, prices, low, high, status }) => (
            <tr key={t.id} className={cx(!low && status !== 'not_needed' && 'no-price')}>
              <td><b>{t.name}</b> {t.csiCode && <span className="muted mono small">{t.csiCode}</span>}</td>
              <td><span className={cx('ts-pill', `ts-${status}`)}>{TRADE_STATUS_LABELS[status]}</span></td>
              <td>{t.bidders.filter((b) => b.drawingsSentAt).length}/{t.bidders.length}</td>
              <td>{t.bidders.filter((b) => b.priceReceivedAt).length}</td>
              <td className="num"><b>{low ? fmtMoney(low.priceAmount) : '-'}</b></td>
              <td>{low?.companyName ?? ''}</td>
              <td className="num">{prices.length > 1 ? fmtMoney(high!.priceAmount) : ''}</td>
              <td className="num">{prices.length > 1 ? fmtMoney(high!.priceAmount! - low!.priceAmount!) : ''}</td>
              <td className="small">
                {prices.map((b) => (
                  <span key={b.id} className={cx('price-tag', b === low && 'low')} title={`Received ${fmtDateTime(b.priceReceivedAt)}`}>
                    {b.companyName}: {fmtMoney(b.priceAmount)}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ActivityTab({ detail }: { detail: JobDetail }) {
  const { toast } = useApp()
  const [mode, setMode] = useState<'activity' | 'changes'>('activity')
  const { data: acts } = useBidQuery(() => bid.listActivities(detail.job.id), [detail.job.id])
  const { data: changes } = useBidQuery(() => bid.listAudit(detail.job.id), [detail.job.id])
  const [note, setNote] = useState('')
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of detail.trades) for (const b of t.bidders) m.set(b.id, `${b.companyName} · ${t.name}`)
    return m
  }, [detail])
  if (mode === 'changes') {
    return (
      <div className="activity">
        <div className="seg small" style={{ marginBottom: 10 }}>
          <button onClick={() => setMode('activity')}>Bid activity</button>
          <button className="on">Change history (who changed what)</button>
        </div>
        <ul className="history big">
          {(changes ?? []).map((c) => (
            <li key={c.id}>
              <span className="h-when">{fmtDateTime(c.at)}</span>
              <b>{c.userName || 'Someone'}</b>
              <span className="h-note">{c.summary}</span>
            </li>
          ))}
          {changes && changes.length === 0 && <li className="muted">No changes recorded yet.</li>}
        </ul>
      </div>
    )
  }
  return (
    <div className="activity">
      <div className="seg small" style={{ marginBottom: 10 }}>
        <button className="on">Bid activity</button>
        <button onClick={() => setMode('changes')}>Change history (who changed what)</button>
      </div>
      <form
        className="note-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (note.trim()) bid.addNote(detail.job.id, note.trim()).then(() => setNote('')).catch((er) => toast(er.message, 'error'))
        }}
      >
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a job note (e.g. Addendum 2 issued, pre-bid meeting moved)..." />
        <Button type="submit" kind="primary">Add note</Button>
      </form>
      <ul className="history big">
        {(acts ?? []).map((a) => (
          <li key={a.id}>
            <span className={cx('h-type', `h-${a.type}`)}>{ACTIVITY_LABELS[a.type]}</span>
            <span className="h-when">{fmtDateTime(a.at)}</span>
            {a.bidderId && <b>{names.get(a.bidderId) ?? '(removed company)'}</b>}
            {a.amount != null && <b>{fmtMoney(a.amount)}</b>}
            {a.note && <span className="h-note">{a.note}</span>}
            {a.userName && <span className="muted h-user">by {a.userName}</span>}
          </li>
        ))}
        {acts && acts.length === 0 && <li className="muted">No activity yet. Invites, calls, prices and notes will show up here.</li>}
      </ul>
    </div>
  )
}