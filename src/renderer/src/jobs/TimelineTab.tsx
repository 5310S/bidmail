// Timeline: the whole bidding process on one date line. Milestones (drag to reschedule, click to edit),
// the takeoff, and one row per trade with a dot for every email, call, "will bid", price and filed quote
// (expand a trade to see each company). Today and the bid due date are marked.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Bidder, JobDetail, Milestone, TAKEOFF_STATUS_LABELS } from '../../../shared/types'
import { bid } from '../api'
import { useApp, useBidQuery } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Modal } from '../components/ui'
import { cx, fmtDate, fmtDateTime, fromLocalInput, toLocalInput } from '../util'
import { PersonInput, STEP_COLORS, StepChecklist, usePeople, useWorkflow } from './workflow'

const DAY = 86400000
const LABEL_W = 230
const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const EVENT_KIND: Partial<Record<Activity['type'], { kind: string; label: string }>> = {
  drawings_sent: { kind: 'drawings_sent', label: 'Emailed drawings' },
  follow_up_call: { kind: 'follow_up', label: 'Called' },
  follow_up_email: { kind: 'follow_up', label: 'Follow-up email' },
  will_bid: { kind: 'will_bid', label: 'Confirmed bidding' },
  price_received: { kind: 'price_received', label: 'Price received' },
  declined: { kind: 'declined', label: 'Not bidding' },
  addendum_sent: { kind: 'addendum', label: 'Addendum sent' },
  step: { kind: 'custom', label: 'Step done' }
}
const DOT_COLOR: Record<string, string> = { ...STEP_COLORS, declined: '#b8312a', addendum: '#7d8ea8' }

interface Dot {
  at: string
  kind: string
  title: string
}

export function TimelineTab({ detail }: { detail: JobDetail }) {
  const { toast, go } = useApp()
  const { steps } = useWorkflow()
  const { data: acts } = useBidQuery(() => bid.listActivities(detail.job.id), [detail.job.id])
  const job = detail.job
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const [zoom, setZoom] = useState(1)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<Partial<Milestone> | null>(null)
  const [openBidder, setOpenBidder] = useState<Bidder | null>(null)
  const [drag, setDrag] = useState<{ id: string; startX: number; dx: number } | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const bidderById = useMemo(() => new Map(detail.trades.flatMap((t) => t.bidders.map((b) => [b.id, b] as const))), [detail])
  const dotsByBidder = useMemo(() => {
    const m = new Map<string, Dot[]>()
    const push = (id: string, d: Dot) => m.set(id, [...(m.get(id) ?? []), d])
    for (const a of acts ?? []) {
      const k = EVENT_KIND[a.type]
      if (!k || !a.bidderId) continue
      const company = bidderById.get(a.bidderId)?.companyName ?? ''
      const label = a.type === 'step' ? a.note : a.type === 'addendum_sent' ? a.note : k.label
      push(a.bidderId, { at: a.at, kind: k.kind, title: `${company}: ${label}, ${fmtDateTime(a.at)}${a.userName ? ' by ' + a.userName : ''}` })
    }
    for (const f of detail.files) {
      if (!f.bidderId) continue
      push(f.bidderId, { at: f.createdAt, kind: 'filed', title: `${bidderById.get(f.bidderId)?.companyName ?? ''}: quote filed (${f.name}), ${fmtDateTime(f.createdAt)}${f.createdBy ? ' by ' + f.createdBy : ''}` })
    }
    return m
  }, [acts, detail.files, bidderById])

  // Date range: from the first thing that happened (or job creation) to a few days past the bid date.
  const times = [Date.parse(job.createdAt), Date.now()]
  if (job.bidDue) times.push(Date.parse(job.bidDue))
  if (job.takeoff.dueAt) times.push(Date.parse(job.takeoff.dueAt))
  for (const m of detail.milestones) if (m.dueAt) times.push(Date.parse(m.dueAt))
  for (const list of dotsByBidder.values()) for (const d of list) times.push(Date.parse(d.at))
  const start = startOfDay(Math.min(...times.filter((t) => !isNaN(t)))) - DAY
  const end = startOfDay(Math.max(...times.filter((t) => !isNaN(t)))) + 3 * DAY
  const days = Math.max(7, Math.round((end - start) / DAY))
  const px = Math.max(26, ((width - LABEL_W - 20) / days) * zoom)
  const trackW = days * px
  const x = (iso: string | number) => ((typeof iso === 'number' ? iso : Date.parse(iso)) - start) / DAY * px

  // Dragging a milestone diamond to a new day.
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, dx: e.clientX - d.startX } : d))
    const up = () => {
      setDrag((d) => {
        if (!d) return null
        const m = detail.milestones.find((x) => x.id === d.id)
        if (m && Math.abs(d.dx) < 4) setEditing(m)
        else if (m?.dueAt) {
          const shift = Math.round(d.dx / px)
          if (shift) bid.updateMilestone(m.id, { dueAt: new Date(Date.parse(m.dueAt) + shift * DAY).toISOString() }).catch((e) => toast(e.message, 'error'))
        }
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag?.id, px])

  // Calendar days built by date (not by adding 24h), so daylight-saving changes don't repeat or skip a day.
  const s0 = new Date(start)
  const dayCells = Array.from({ length: days }, (_, i) => new Date(s0.getFullYear(), s0.getMonth(), s0.getDate() + i))
  // Stack milestone labels on extra lines when they would overlap.
  const dated = detail.milestones.filter((m) => m.dueAt).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
  const laneEnds: number[] = []
  const laneOf = new Map<string, number>()
  for (const m of dated) {
    const left = x(m.dueAt!) - 7
    const w = (m.name.length + (m.owner ? m.owner.length + 3 : 0)) * 6.4 + 14
    let lane = laneEnds.findIndex((end) => end < left)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = left + w
    laneOf.set(m.id, lane)
  }
  const msHeight = 40 + Math.max(1, laneEnds.length) * 18
  const guides = (
    <>
      <span className="tl-today" style={{ left: x(Date.now()) }} title="Today" />
      {job.bidDue && <span className="tl-biddue" style={{ left: x(job.bidDue) }} title={`Bid due ${fmtDateTime(job.bidDue)}`} />}
    </>
  )
  const track = (children: React.ReactNode) => (
    <div className="tl-track" style={{ width: trackW, backgroundSize: `${px}px 100%` }}>
      {guides}
      {children}
    </div>
  )
  const dots = (list: Dot[]) => list.map((d, i) => (
    <span key={i} className={cx('tl-dot', `k-${d.kind}`)} style={{ left: x(d.at), background: DOT_COLOR[d.kind] }} title={d.title} />
  ))
  const undated = detail.milestones.filter((m) => !m.dueAt)
  const t = job.takeoff

  return (
    <div className="timeline">
      <div className="toolbar">
        <Button icon="plus" onClick={() => setEditing({ name: '', dueAt: null, owner: '', notes: '' })}>Milestone</Button>
        {detail.milestones.length === 0 && <Button onClick={() => bid.applyMilestoneTemplate(job.id)}>Add standard milestones</Button>}
        <div className="text-size" title="Zoom">
          <button onClick={() => setZoom((z) => Math.max(0.5, z / 1.4))}>-</button>
          <span>Zoom</span>
          <button onClick={() => setZoom((z) => Math.min(6, z * 1.4))}>+</button>
        </div>
        <div className="tl-legend">
          {steps.map((s) => <span key={s.id}><i style={{ background: STEP_COLORS[s.kind] }} />{s.name}</span>)}
          <span><i style={{ background: DOT_COLOR.declined }} />Not bidding</span>
          <span><i className="tl-legend-today" />Today</span>
          {job.bidDue && <span><i className="tl-legend-due" />Bid due</span>}
        </div>
        <span className="grow" />
        <Button small icon="settings" onClick={() => go({ kind: 'settings', tab: 'workflow' })}>Customize</Button>
      </div>

      <div className="tl-wrap" ref={wrap}>
        <div className="tl-grid" style={{ width: LABEL_W + trackW }}>
          <div className="tl-row tl-scale">
            <div className="tl-label" />
            <div className="tl-track" style={{ width: trackW }}>
              {dayCells.map((d, i) => (
                <span key={i} className={cx('tl-day', d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : '', d.toDateString() === new Date().toDateString() && 'is-today')} style={{ left: i * px, width: px }}>
                  {(px >= 34 || d.getDay() === 1 || i === 0) && (
                    <>
                      <b>{d.getDate() === 1 || i === 0 || px >= 34 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}</b>
                      {px >= 34 && <small>{d.toLocaleDateString('en-US', { weekday: 'narrow' })}</small>}
                    </>
                  )}
                </span>
              ))}
            </div>
          </div>

          <div className="tl-row tl-milestones" style={{ minHeight: msHeight }}>
            <div className="tl-label"><b>Milestones</b>{undated.length > 0 && <div className="muted small">{undated.length} without a date</div>}</div>
            {track(detail.milestones.filter((m) => m.dueAt).map((m) => {
              const overdue = !m.doneAt && Date.parse(m.dueAt!) < Date.now()
              const dx = drag?.id === m.id ? drag.dx : 0
              return (
                <div
                  key={m.id}
                  className={cx('tl-ms', m.doneAt ? 'done' : overdue ? 'overdue' : '')}
                  style={{ left: x(m.dueAt!) + dx }}
                  onPointerDown={(e) => { e.preventDefault(); setDrag({ id: m.id, startX: e.clientX, dx: 0 }) }}
                  title={`${m.name}: ${fmtDateTime(m.dueAt)}${m.owner ? ' · ' + m.owner : ''}${m.doneAt ? ' · done' : ''}${m.updatedBy ? '\nUpdated by ' + m.updatedBy : ''}\nDrag to move, click to edit`}
                >
                  <span className="tl-diamond" />
                  <span className="tl-ms-label" style={{ marginTop: 4 + (laneOf.get(m.id) ?? 0) * 18 }}>{m.name}{m.owner ? ` · ${m.owner}` : ''}</span>
                </div>
              )
            }))}
          </div>

          <div className="tl-row">
            <div className="tl-label"><b>Takeoff</b><div className="muted small">{t.assignee || 'unassigned'} · {TAKEOFF_STATUS_LABELS[t.status]}</div></div>
            {track(t.dueAt ? (
              <span
                className={cx('tl-bar', `tk-${t.status}`)}
                style={{ left: x(job.createdAt), width: Math.max(8, x(t.dueAt) - x(job.createdAt)) }}
                title={`Takeoff ${TAKEOFF_STATUS_LABELS[t.status]}${t.assignee ? ' · ' + t.assignee : ''}, due ${fmtDateTime(t.dueAt)}${t.updatedBy ? '\nUpdated by ' + t.updatedBy : ''}`}
              >
                {t.assignee}
              </span>
            ) : (
              <span className="tl-hint" style={{ left: 8 }}>Set the takeoff due date in the job header</span>
            ))}
          </div>

          {detail.trades.map((tr) => {
            const all = tr.bidders.flatMap((b) => dotsByBidder.get(b.id) ?? [])
            const priced = tr.bidders.filter((b) => b.priceReceivedAt).length
            return (
              <div key={tr.id} className="tl-trade">
                <div className="tl-row">
                  <div className="tl-label">
                    <button className="tl-toggle" onClick={() => setExpanded((e) => ({ ...e, [tr.id]: !e[tr.id] }))}>
                      <Icon name={expanded[tr.id] ? 'chevronDown' : 'chevronRight'} size={14} /> <b>{tr.name}</b>
                    </button>
                    <div className="muted small">{priced}/{tr.bidders.length} priced</div>
                  </div>
                  {track(dots(all))}
                </div>
                {expanded[tr.id] && tr.bidders.map((b) => (
                  <div key={b.id} className="tl-row tl-sub">
                    <div className="tl-label"><button className="link-btn" onClick={() => setOpenBidder(b)} title="Steps, who and when">{b.companyName}</button></div>
                    {track(dots(dotsByBidder.get(b.id) ?? []))}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {undated.length > 0 && (
        <div className="tl-undated">
          <span className="field-label">No date yet:</span>
          {undated.map((m) => <button key={m.id} className="chip" onClick={() => setEditing(m)}>{m.name}</button>)}
        </div>
      )}

      {editing && <MilestoneEditor jobId={job.id} m={editing} onClose={() => setEditing(null)} />}
      {openBidder && (
        <Modal title={openBidder.companyName} onClose={() => setOpenBidder(null)} width={520}>
          <StepChecklist b={bidderById.get(openBidder.id) ?? openBidder} steps={steps} files={detail.files} jobId={job.id} />
        </Modal>
      )}
    </div>
  )
}

function MilestoneEditor({ jobId, m, onClose }: { jobId: string; m: Partial<Milestone>; onClose: () => void }) {
  const { toast, confirm } = useApp()
  const people = usePeople(m.owner ? [m.owner] : [])
  const [f, setF] = useState({ name: m.name ?? '', dueAt: toLocalInput(m.dueAt), owner: m.owner ?? '', notes: m.notes ?? '', done: !!m.doneAt })
  const save = async () => {
    if (!f.name.trim()) return toast('Give the milestone a name.', 'error')
    const data = { name: f.name.trim(), dueAt: fromLocalInput(f.dueAt), owner: f.owner, notes: f.notes, doneAt: f.done ? m.doneAt ?? new Date().toISOString() : null }
    try {
      if (m.id) await bid.updateMilestone(m.id, data)
      else await bid.addMilestone(jobId, data)
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <Modal title={m.id ? 'Milestone' : 'Add milestone'} onClose={onClose} width={520}
      footer={<>
        {m.id && <Button kind="danger" icon="trash" onClick={async () => { if (await confirm({ title: 'Delete milestone?', message: `Delete "${m.name}" from this job?` })) { await bid.deleteMilestone(m.id!); onClose() } }}>Delete</Button>}
        <span className="grow" />
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" onClick={save}>Save</Button>
      </>}>
      <div className="form-grid">
        <Field label="Name" wide><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Pre-bid meeting" /></Field>
        <Field label="Date & time"><input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Owner"><PersonInput value={f.owner} onChange={(v) => setF({ ...f, owner: v })} names={people} placeholder="Who's responsible?" /></Field>
        <Field label="Notes" wide><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <label className="check field-wide"><input type="checkbox" checked={f.done} onChange={(e) => setF({ ...f, done: e.target.checked })} /> Done{m.doneAt ? ` (${fmtDate(m.doneAt)})` : ''}</label>
      </div>
      {m.updatedBy && <p className="muted small">Last changed by {m.updatedBy}, {fmtDateTime(m.updatedAt)}</p>}
    </Modal>
  )
}