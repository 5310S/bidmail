import { useEffect, useMemo, useState } from 'react'
import {
  Activity, Addendum, Bidder, BIDDER_STAGE_LABELS, bidderStage, CompanyWithStats, effectiveTradeStatus, expiresSoon, FileMeta, Job,
  TradeStatus, TRADE_STATUS_LABELS, TradeWithBidders
} from '../../../shared/types'
import { bid } from '../api'
import { useApp, useBidQuery } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Menu, Modal } from '../components/ui'
import { cx, fmtDate, fmtDateTime, fmtMoney } from '../util'
import { DrawingsCell, FollowUpCell, PriceCell } from './Checkpoints'
import { QuoteFiles } from './QuoteFiles'
import { TradeSettings } from './TradeSettings'
import { StepChecklist, useWorkflow } from './workflow'

export const ACTIVITY_LABELS: Record<Activity['type'], string> = {
  drawings_sent: 'Drawings sent',
  follow_up_call: 'Called',
  follow_up_email: 'Follow-up email',
  price_received: 'Price received',
  declined: 'Not bidding',
  will_bid: 'Will bid',
  addendum_sent: 'Addendum sent',
  addendum_ack: 'Addendum acknowledged',
  step: 'Step done',
  note: 'Note',
  cleared: 'Cleared'
}

/** Insurance/prequalification problems for a company in the directory, as short warnings. */
export function companyWarnings(c: CompanyWithStats | undefined): string[] {
  if (!c) return []
  const w: string[] = []
  const gl = expiresSoon(c.glExpires)
  const wc = expiresSoon(c.wcExpires)
  if (gl === 'expired') w.push(`Liability insurance expired ${fmtDate(c.glExpires)}`)
  else if (gl === 'soon') w.push(`Liability insurance expires ${fmtDate(c.glExpires)}`)
  if (wc === 'expired') w.push(`Workers' comp expired ${fmtDate(c.wcExpires)}`)
  else if (wc === 'soon') w.push(`Workers' comp expires ${fmtDate(c.wcExpires)}`)
  return w
}

interface CardProps {
  job: Job
  trade: TradeWithBidders
  trades: TradeWithBidders[]
  addenda: Addendum[]
  files: FileMeta[]
  companies: Map<string, CompanyWithStats>
  collapsed: boolean
  onToggle: () => void
  onBulk: (tradeId: string) => void
  highlight: string
}

export function TradeCard({ job, trade, trades, addenda, files, companies, collapsed, onToggle, onBulk, highlight }: CardProps) {
  const { toast, confirm, compose } = useApp()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(trade.name)
  const [adding, setAdding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const status = effectiveTradeStatus(trade)
  const priced = trade.bidders.filter((b) => b.priceReceivedAt)
  const willBid = trade.bidders.filter((b) => b.willBidAt && !b.priceReceivedAt).length
  const invited = trade.bidders.filter((b) => b.drawingsSentAt).length
  const short = invited > 0 && priced.length + willBid < 3 && status !== 'covered' && status !== 'not_needed'
  const low = priced.filter((b) => b.priceAmount != null).sort((a, b) => a.priceAmount! - b.priceAmount!)[0]
  const filtered = highlight
    ? trade.bidders.filter((b) => [b.companyName, b.contactName, b.email].some((v) => v.toLowerCase().includes(highlight)))
    : trade.bidders

  const emailBidder = (b: Bidder) =>
    compose({
      to: b.contactName ? `${b.contactName.replace(/[,;"<>]/g, '')} <${b.email.split(/[;,\s]+/)[0]}>` : b.email,
      heading: `Email ${b.companyName}`,
      merge: { jobId: job.id, bidderId: b.id },
      bidderAction: b.drawingsSentAt ? undefined : { bidderId: b.id, action: 'drawings_sent' }
    })

  const saveName = async () => {
    setRenaming(false)
    if (name.trim() && name !== trade.name) await bid.updateTrade(trade.id, { name: name.trim() }).catch((e) => toast(e.message, 'error'))
  }

  return (
    <section className={cx('trade-card', `ts-${status}`)}>
      <header className="trade-head">
        <button className="trade-toggle" onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} />
        </button>
        {trade.csiCode && <span className="csi mono">{trade.csiCode}</span>}
        {renaming ? (
          <input className="trade-rename" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
        ) : (
          <h3 onDoubleClick={() => setRenaming(true)} title="Double-click to rename">{trade.name}</h3>
        )}
        <select
          className={cx('trade-status', `ts-${status}`)}
          value={trade.status}
          onChange={(e) => bid.updateTrade(trade.id, { status: e.target.value as TradeStatus }).catch((er) => toast(er.message, 'error'))}
          title="Trade status (Auto = based on the companies below)"
        >
          {Object.entries(TRADE_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{k === 'auto' ? `Auto: ${TRADE_STATUS_LABELS[status]}` : v}</option>
          ))}
        </select>
        <span className="trade-meta">
          <b>{priced.length}</b> of {trade.bidders.length} priced{willBid > 0 && <> · <b>{willBid}</b> will bid</>} · {invited} invited
          {low && <> · low <b>{fmtMoney(low.priceAmount)}</b></>}
        </span>
        {short && <span className="short-badge" title="Fewer than 3 prices in or promised. Consider inviting more companies."><Icon name="alert" size={13} /> Short</span>}
        {(trade.drawingsLink || trade.specsLink) && <span className="tag" title={trade.drawingsLink || trade.specsLink}>own drawings</span>}
        <span className="grow" />
        <Button small icon="plus" onClick={() => setAdding(true)}>Company</Button>
        <Button small icon="send" onClick={() => onBulk(trade.id)} disabled={!trade.bidders.length}>Email Trade</Button>
        <Menu
          align="right"
          trigger={(open) => <Button small kind="ghost" icon="more" onClick={open} />}
          items={[
            { label: 'Links, scope note & checklist...', icon: 'link', onClick: () => setSettingsOpen(true) },
            { label: 'Rename trade', icon: 'edit', onClick: () => setRenaming(true) },
            {
              label: 'Delete trade',
              icon: 'trash',
              danger: true,
              onClick: async () => {
                if (await confirm({ title: 'Delete trade?', message: `Delete "${trade.name}" and its ${trade.bidders.length} companies from this job?` }))
                  bid.deleteTrade(trade.id).catch((e) => toast(e.message, 'error'))
              }
            }
          ]}
        />
      </header>
      {!collapsed && (
        <div className="bidders">
          {trade.bidders.length === 0 ? (
            <div className="bidders-empty">
              No companies yet. <button className="link-btn" onClick={() => setAdding(true)}>Add companies to invite</button>
            </div>
          ) : (
            <table className="bidder-table">
              <thead>
                <tr>
                  <th style={{ width: '27%' }}>Company</th>
                  <th>Drawings Sent</th>
                  <th>Follow-Up</th>
                  <th>Price</th>
                  <th style={{ width: 120 }}>Status</th>
                  <th style={{ width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => (
                  <BidderRow
                    key={b.id}
                    b={b}
                    isLow={!!low && low.id === b.id && priced.length > 1}
                    expanded={expanded === b.id}
                    onExpand={() => setExpanded(expanded === b.id ? null : b.id)}
                    onEmail={() => emailBidder(b)}
                    trades={trades}
                    jobId={job.id}
                    addenda={addenda}
                    files={files}
                    company={b.companyId ? companies.get(b.companyId) : undefined}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {adding && <AddCompaniesModal trade={trade} onClose={() => setAdding(false)} />}
      {settingsOpen && <TradeSettings trade={trade} onClose={() => setSettingsOpen(false)} />}
    </section>
  )
}

function StatusMenu({ b }: { b: Bidder }) {
  const { toast } = useApp()
  const stage = bidderStage(b)
  const act = (a: Parameters<typeof bid.bidderAction>[1]) => bid.bidderAction(b.id, a).catch((e) => toast(e.message, 'error'))
  return (
    <Menu
      trigger={(open) => (
        <button className={cx('stage stage-btn', `st-${stage}`)} onClick={open} title="Change status">
          {BIDDER_STAGE_LABELS[stage]} <Icon name="chevronDown" size={11} />
        </button>
      )}
      items={[
        b.willBidAt ? { label: 'Undo "Will Bid"', icon: 'x', onClick: () => act('clear_will_bid') } : { label: 'Will Bid (confirmed)', icon: 'check', onClick: () => act('will_bid') },
        b.declinedAt ? { label: 'Undo "Not Bidding"', icon: 'x', onClick: () => act('clear_declined') } : { label: 'Not Bidding', icon: 'ban', onClick: () => act('declined') }
      ]}
    />
  )
}

function AddendaBadges({ b, addenda }: { b: Bidder; addenda: Addendum[] }) {
  if (!addenda.length || !b.drawingsSentAt || b.declinedAt) return null
  return (
    <span className="add-badges">
      {addenda.map((a) => {
        const sent = b.addendaSent[a.id]
        const ack = b.addendaAck[a.id]
        return (
          <span
            key={a.id}
            className={cx('add-badge', ack ? 'ack' : sent ? 'sent' : 'missing')}
            title={`Addendum ${a.number}: ${ack ? 'acknowledged ' + fmtDateTime(ack) : sent ? 'sent ' + fmtDateTime(sent) + ', not acknowledged' : 'NOT SENT'}`}
          >
            A{a.number}
          </span>
        )
      })}
    </span>
  )
}

function BidderRow({
  b, isLow, expanded, onExpand, onEmail, trades, jobId, addenda, files, company
}: {
  b: Bidder
  isLow: boolean
  expanded: boolean
  onExpand: () => void
  onEmail: () => void
  trades: TradeWithBidders[]
  jobId: string
  addenda: Addendum[]
  files: FileMeta[]
  company: CompanyWithStats | undefined
}) {
  const { toast, confirm } = useApp()
  const [editing, setEditing] = useState(false)
  const stage = bidderStage(b)
  const warnings = companyWarnings(company)
  const nFiles = files.filter((f) => f.bidderId === b.id).length
  return (
    <>
      <tr className={cx('bidder-row', `st-${stage}`, expanded && 'open')}>
        <td>
          <div className="bidder-name">
            <button className="link-strong" onClick={onExpand} title="Show details, quote & history">{b.companyName}</button>
            {isLow && <span className="low-badge">LOW</span>}
            {warnings.length > 0 && <span className="warn-icon" title={warnings.join('\n')}><Icon name="alert" size={14} /></span>}
            {nFiles > 0 && <span className="muted" title={`${nFiles} quote file(s)`}><Icon name="paperclip" size={13} /></span>}
            <AddendaBadges b={b} addenda={addenda} />
          </div>
          <div className="bidder-contact muted">
            {[b.contactName, b.email, b.phone].filter(Boolean).join(' · ') || <i>No contact info</i>}
          </div>
        </td>
        <td><DrawingsCell b={b} onEmail={onEmail} /></td>
        <td><FollowUpCell b={b} /></td>
        <td><PriceCell b={b} /></td>
        <td><StatusMenu b={b} /></td>
        <td className="row-actions">
          <Button small kind="ghost" icon="mail" title="Email this company" onClick={onEmail} />
          <Menu
            align="right"
            trigger={(open) => <Button small kind="ghost" icon="more" onClick={open} />}
            items={[
              { label: 'Edit company info', icon: 'edit', onClick: () => setEditing(true) },
              { label: 'Details, quote & history', icon: 'activity', onClick: onExpand },
              'sep',
              ...trades
                .filter((t) => t.id !== b.tradeId)
                .slice(0, 15)
                .map((t) => ({ label: `Move to ${t.name}`, icon: 'move', onClick: () => bid.moveBidder(b.id, t.id) })),
              'sep',
              {
                label: 'Remove from job',
                icon: 'trash',
                danger: true,
                onClick: async () => {
                  if (await confirm({ title: 'Remove company?', message: `Remove ${b.companyName} from this trade? Its history on this job will be deleted.`, confirmLabel: 'Remove' }))
                    bid.deleteBidder(b.id).catch((e) => toast(e.message, 'error'))
                }
              }
            ]}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="bidder-detail-row">
          <td colSpan={6}>
            <BidderDetail b={b} jobId={jobId} addenda={addenda} files={files} warnings={warnings} company={company} />
          </td>
        </tr>
      )}
      {editing && <EditBidderModal b={b} onClose={() => setEditing(false)} />}
    </>
  )
}

function BidderDetail({ b, jobId, addenda, files, warnings, company }: { b: Bidder; jobId: string; addenda: Addendum[]; files: FileMeta[]; warnings: string[]; company: CompanyWithStats | undefined }) {
  const { toast } = useApp()
  const { data: acts } = useBidQuery(() => bid.listActivities(jobId, b.id), [b.id])
  const { steps } = useWorkflow()
  const [f, setF] = useState({ notes: b.notes, inclusions: b.inclusions, exclusions: b.exclusions })
  const [note, setNote] = useState('')
  useEffect(() => setF({ notes: b.notes, inclusions: b.inclusions, exclusions: b.exclusions }), [b.notes, b.inclusions, b.exclusions])
  const saveField = (k: keyof typeof f) => () => f[k] !== b[k] && bid.updateBidder(b.id, { [k]: f[k] }).catch((e) => toast(e.message, 'error'))
  return (
    <div className="bidder-detail">
      <div className="bd-col">
        {warnings.map((w) => <div key={w} className="warn-box"><Icon name="alert" size={15} /> {w}</div>)}
        {company && (
          <div className="muted small">
            Bidding history: priced {company.pricedCount} of {company.invitedCount} invitations
            {company.certifications && <> · {company.certifications}</>}
            {company.prequalified && <> · <span className="ok-text">Prequalified</span></>}
          </div>
        )}
        <div className="form-grid">
          <Field label="Inclusions"><textarea rows={2} value={f.inclusions} onChange={(e) => setF({ ...f, inclusions: e.target.value })} onBlur={saveField('inclusions')} /></Field>
          <Field label="Exclusions"><textarea rows={2} value={f.exclusions} onChange={(e) => setF({ ...f, exclusions: e.target.value })} onBlur={saveField('exclusions')} /></Field>
          <Field label="Notes about this company on this job" wide>
            <textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} onBlur={saveField('notes')} placeholder="Scope notes, contacts..." />
          </Field>
        </div>
        <div className="field-label">Quote files</div>
        <QuoteFiles jobId={jobId} bidderId={b.id} list={files} />
        {addenda.length > 0 && b.drawingsSentAt && (
          <>
            <div className="field-label" style={{ marginTop: 8 }}>Addenda</div>
            <ul className="add-list">
              {addenda.map((a) => (
                <li key={a.id}>
                  <b>Addendum {a.number}</b>
                  {b.addendaSent[a.id] ? <span className="muted">sent {fmtDateTime(b.addendaSent[a.id])}</span> : (
                    <button className="link-btn" onClick={() => bid.markAddendumSent(a.id, [b.id])}>mark sent</button>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={!!b.addendaAck[a.id]} onChange={(e) => bid.setAddendumAck(a.id, b.id, e.target.checked ? new Date().toISOString() : null)} />
                    acknowledged
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="bd-col">
        <div className="field-label">Steps (who and when)</div>
        <StepChecklist b={b} steps={steps} files={files} jobId={jobId} />
        <div className="field-label">History</div>
        <form
          className="note-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (!note.trim()) return
            bid.addNote(jobId, note.trim(), b.id).then(() => setNote(''))
          }}
        >
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the history..." />
          <Button small type="submit">Add</Button>
        </form>
        <ul className="history">
          {(acts ?? []).map((a) => (
            <li key={a.id}>
              <span className={cx('h-type', `h-${a.type}`)}>{ACTIVITY_LABELS[a.type]}</span>
              <span className="h-when">{fmtDateTime(a.at)}</span>
              {a.amount != null && <b>{fmtMoney(a.amount)}</b>}
              {a.note && <span className="h-note">{a.note}</span>}
              {a.userName && <span className="muted h-user">{a.userName}</span>}
            </li>
          ))}
          {acts && acts.length === 0 && <li className="muted">No activity yet.</li>}
        </ul>
      </div>
    </div>
  )
}

function EditBidderModal({ b, onClose }: { b: Bidder; onClose: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({ companyName: b.companyName, contactName: b.contactName, email: b.email, phone: b.phone })
  const [updateDir, setUpdateDir] = useState(!!b.companyId)
  const save = async () => {
    try {
      await bid.updateBidder(b.id, f)
      if (updateDir && b.companyId) {
        await bid.saveCompany({ id: b.companyId, name: f.companyName, contactName: f.contactName, email: f.email, phone: f.phone })
      }
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }))
  return (
    <Modal title="Edit company" onClose={onClose} width={520} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Company" wide><input autoFocus value={f.companyName} onChange={set('companyName')} /></Field>
        <Field label="Contact name"><input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email (separate several with commas)" wide><input value={f.email} onChange={set('email')} /></Field>
        {b.companyId && (
          <label className="check field-wide">
            <input type="checkbox" checked={updateDir} onChange={(e) => setUpdateDir(e.target.checked)} />
            Also update this company in the company directory
          </label>
        )}
      </div>
    </Modal>
  )
}
/** Pick companies from the directory (suggested by trade) or add a new one. */
export function AddCompaniesModal({ trade, onClose }: { trade: TradeWithBidders; onClose: () => void }) {
  const { toast } = useApp()
  const { data: companies } = useBidQuery(() => bid.listCompanies(), [])
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<'directory' | 'new'>('directory')
  const [nf, setNf] = useState({ name: '', contactName: '', email: '', phone: '' })
  const [saveToDir, setSaveToDir] = useState(true)
  const [busy, setBusy] = useState(false)

  const existing = new Set(trade.bidders.map((b) => b.companyId).filter(Boolean))
  const existingEmails = new Set(trade.bidders.map((b) => b.email.toLowerCase()).filter(Boolean))
  const tradeWords = trade.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3)

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    const all = (companies ?? []).filter((c) =>
      !s || [c.name, c.contactName, c.email, c.trades, c.certifications].some((v) => v.toLowerCase().includes(s))
    )
    const score = (c: CompanyWithStats) => {
      const t = c.trades.toLowerCase()
      return t.includes(trade.name.toLowerCase()) ? 2 : tradeWords.some((w) => t.includes(w)) ? 1 : 0
    }
    return all.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name)).map((c) => ({ c, suggested: score(c) > 0 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, q, trade.name])

  const addSelected = async () => {
    const picks = (companies ?? []).filter((c) => sel.has(c.id))
    if (!picks.length) return
    setBusy(true)
    try {
      await bid.addBidders(trade.id, picks.map((c) => ({ companyId: c.id, companyName: c.name, contactName: c.contactName, email: c.email, phone: c.phone })))
      toast(`Added ${picks.length} compan${picks.length === 1 ? 'y' : 'ies'} to ${trade.name}`, 'success')
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const addNew = async (keepOpen: boolean) => {
    if (!nf.name.trim()) return toast('Enter the company name.', 'error')
    setBusy(true)
    try {
      let companyId: string | null = null
      if (saveToDir) companyId = (await bid.saveCompany({ ...nf, trades: trade.name })).id
      await bid.addBidder(trade.id, { companyId, companyName: nf.name, contactName: nf.contactName, email: nf.email, phone: nf.phone })
      toast(`Added ${nf.name}`, 'success')
      setNf({ name: '', contactName: '', email: '', phone: '' })
      if (!keepOpen) onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Add companies to ${trade.name}`}
      onClose={onClose}
      width={720}
      footer={
        tab === 'directory' ? (
          <>
            <span className="muted grow">{sel.size} selected</span>
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="primary" onClick={addSelected} disabled={!sel.size || busy}>Add selected</Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button onClick={onClose}>Cancel</Button>
            <Button onClick={() => addNew(true)} disabled={busy}>Add & add another</Button>
            <Button kind="primary" onClick={() => addNew(false)} disabled={busy}>Add</Button>
          </>
        )
      }
    >
      <div className="seg">
        <button className={tab === 'directory' ? 'on' : ''} onClick={() => setTab('directory')}>From company directory</button>
        <button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>New company</button>
      </div>
      {tab === 'directory' ? (
        <>
          <div className="search-box" style={{ margin: '12px 0' }}>
            <Icon name="search" size={16} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies, contacts, trades, certifications" />
          </div>
          <div className="pick-list">
            {list.length === 0 && (
              <div className="muted pad">
                {companies?.length ? 'No matches.' : 'Your company directory is empty. Add a new company, or import a list in Companies.'}
              </div>
            )}
            {list.map(({ c, suggested }) => {
              const already = existing.has(c.id) || (c.email && existingEmails.has(c.email.toLowerCase()))
              const warns = companyWarnings(c)
              const rate = c.invitedCount ? Math.round((c.pricedCount / c.invitedCount) * 100) : null
              return (
                <label key={c.id} className={cx('pick-row', already && 'disabled')}>
                  <input
                    type="checkbox"
                    disabled={!!already}
                    checked={sel.has(c.id)}
                    onChange={(e) => {
                      const n = new Set(sel)
                      if (e.target.checked) n.add(c.id)
                      else n.delete(c.id)
                      setSel(n)
                    }}
                  />
                  <div className="grow">
                    <b>{c.name}</b> {suggested && <span className="tag">Suggested</span>} {already && <span className="tag">Already added</span>}
                    {c.prequalified && <span className="tag ok">Prequalified</span>}
                    {warns.length > 0 && <span className="tag bad" title={warns.join('\n')}>Insurance</span>}
                    <div className="muted small">{[c.contactName, c.email, c.phone].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="pick-meta">
                    <span className="muted small ellipsis" style={{ maxWidth: 200 }}>{c.trades}</span>
                    {rate != null && <span className={cx('small', rate < 30 && 'err')} title={`Priced ${c.pricedCount} of ${c.invitedCount} invitations`}>prices {rate}% of the time</span>}
                  </div>
                </label>
              )
            })}
          </div>
        </>
      ) : (
        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label="Company" wide><input autoFocus value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} /></Field>
          <Field label="Contact name"><input value={nf.contactName} onChange={(e) => setNf({ ...nf, contactName: e.target.value })} /></Field>
          <Field label="Phone"><input value={nf.phone} onChange={(e) => setNf({ ...nf, phone: e.target.value })} /></Field>
          <Field label="Email (separate several with commas)" wide><input value={nf.email} onChange={(e) => setNf({ ...nf, email: e.target.value })} /></Field>
          <label className="check field-wide">
            <input type="checkbox" checked={saveToDir} onChange={(e) => setSaveToDir(e.target.checked)} />
            Save to the company directory (trade: {trade.name}) for future jobs
          </label>
        </div>
      )}
    </Modal>
  )
}