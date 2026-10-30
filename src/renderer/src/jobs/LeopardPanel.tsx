// Leopard on a job: link the job to its Leopard project, import the takeoff (a copy is saved with the job and in
// Leopard's storage), and turn the quantities into trades for request-for-bid emails.
import { useEffect, useState } from 'react'
import type { LeopardProjectInfo, LeopardStatus, TakeoffAnalysisResult } from '../../../shared/ipc'
import type { JobDetail } from '../../../shared/types'
import { fmtQty } from '../../../shared/takeoffAnalysis'
import { bid, leopardApi } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Menu, Modal, Spinner } from '../components/ui'
import { cx, fmtDateTime } from '../util'

const totalsText = (totals: { unit: string; quantity: number }[]) => totals.map((t) => fmtQty(t.quantity, t.unit)).join(' · ')
const ago = (ms: number | null) => (ms ? fmtDateTime(new Date(ms).toISOString()) : '')

/** The Leopard box in the job header. */
export function LeopardFact({ detail, onSendInvites }: { detail: JobDetail; onSendInvites: () => void }) {
  const { go, toast, confirm } = useApp()
  const link = detail.job.leopard
  const [picking, setPicking] = useState(false)
  const [importing, setImporting] = useState(false)
  const [status, setStatus] = useState<LeopardStatus | null>(null)
  useEffect(() => {
    leopardApi.status().then(setStatus).catch(() => setStatus(null))
  }, [])
  const signedIn = !!status?.signedIn
  const needSignIn = () => go({ kind: 'settings', tab: 'leopard' })

  return (
    <div className={cx('fact leopard', link ? 'linked' : 'unlinked')}>
      <Icon name="grid" />
      <div className="lp-body">
        <div className="fact-label">Leopard takeoff</div>
        {link ? (
          <>
            <div className="fact-value ellipsis" title={link.projectName}>{link.projectName}</div>
            <div className="muted small">
              {link.takeoffImportedAt ? `Imported ${fmtDateTime(link.takeoffImportedAt)}${link.takeoffImportedBy ? ` by ${link.takeoffImportedBy}` : ''} · ${link.itemCount} items` : `Linked by ${link.linkedBy || 'a teammate'} · not imported yet`}
            </div>
            <div className="lp-actions">
              <Button small kind={link.takeoffImportedAt ? 'default' : 'primary'} icon="download" onClick={() => (signedIn ? setImporting(true) : needSignIn())}>
                {link.takeoffImportedAt ? 'Re-import' : 'Import takeoff'}
              </Button>
              <Button small icon="external" title="Open this project in Leopard" onClick={() => leopardApi.open(link.projectId)} />
              <Menu
                align="right"
                trigger={(open) => <Button small icon="more" onClick={open} />}
                items={[
                  { label: 'Link a different project', icon: 'link', onClick: () => (signedIn ? setPicking(true) : needSignIn()) },
                  {
                    label: 'Unlink Leopard project',
                    icon: 'x',
                    onClick: async () => {
                      if (await confirm({ title: 'Unlink Leopard project?', message: <>The imported quantities stay on the trades. Nothing is deleted in Leopard.</> }))
                        leopardApi.link(detail.job.id, null).catch((e) => toast(e.message, 'error'))
                    }
                  }
                ]}
              />
            </div>
          </>
        ) : (
          <>
            <div className="fact-value muted">Not linked</div>
            <div className="lp-actions">
              <Button small icon="link" onClick={() => (signedIn ? setPicking(true) : needSignIn())}>{signedIn || !status ? 'Link project' : 'Connect Leopard'}</Button>
            </div>
          </>
        )}
      </div>
      {picking && <LinkProjectModal detail={detail} onClose={() => setPicking(false)} onLinked={() => { setPicking(false); setImporting(true) }} />}
      {importing && <ImportTakeoffModal detail={detail} onClose={() => setImporting(false)} onSendInvites={() => { setImporting(false); onSendInvites() }} />}
    </div>
  )
}

function LinkProjectModal({ detail, onClose, onLinked }: { detail: JobDetail; onClose: () => void; onLinked: () => void }) {
  const { toast } = useApp()
  const [list, setList] = useState<LeopardProjectInfo[] | null>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    leopardApi.projects().then(setList).catch((e) => setError(e.message))
  }, [])
  const job = detail.job
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  const score = (p: LeopardProjectInfo) => {
    if (job.number && p.number && job.number === p.number) return 100
    const jw = new Set(words(job.name))
    return words(p.name).filter((w) => jw.has(w)).length
  }
  const search = q.trim().toLowerCase()
  const shown = (list ?? [])
    .filter((p) => !search || [p.name, p.number, p.location].some((v) => v.toLowerCase().includes(search)))
    .sort((a, b) => score(b) - score(a))
  const best = shown[0] && score(shown[0]) > 0 ? shown[0].id : ''

  const choose = async (id: string) => {
    setBusy(true)
    try {
      await leopardApi.link(job.id, id)
      toast('Linked to Leopard', 'success')
      onLinked()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const create = async () => {
    setBusy(true)
    try {
      await leopardApi.create(job.id)
      toast(`Created "${job.name}" in Leopard and linked it`, 'success')
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Link a Leopard project · ${job.name}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button icon="plus" disabled={busy} onClick={create} title="Creates a Leopard project with this job's name, number and location">Create "{job.name}" in Leopard</Button>
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {error ? (
        <div className="error-box">{error}</div>
      ) : !list ? (
        <Spinner label="Loading your Leopard projects..." />
      ) : (
        <>
          <div className="search-box wide">
            <Icon name="search" size={16} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project" />
          </div>
          {list.length === 0 && <Empty icon="grid" title="No projects in Leopard yet">Create one from this job below.</Empty>}
          <ul className="lp-projects">
            {shown.map((p) => (
              <li key={p.id}>
                <button disabled={busy} className={cx(p.id === best && 'best', p.id === job.leopard?.projectId && 'current')} onClick={() => choose(p.id)}>
                  <span className="grow">
                    <b>{p.name}</b>
                    {p.id === best && <span className="chip sm">Best match</span>}
                    {p.id === job.leopard?.projectId && <span className="chip sm">Linked now</span>}
                    <div className="muted small">{[p.number && `#${p.number}`, p.location, p.changed && `changed ${ago(p.changed)}`].filter(Boolean).join(' · ')}</div>
                  </span>
                  <span className={cx('small', p.takeoffSaved ? 'ok' : 'muted')}>{p.takeoffSaved ? `Takeoff saved ${ago(p.takeoffSaved)}` : 'No takeoff yet'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}

export function ImportTakeoffModal({ detail, onClose, onSendInvites }: { detail: JobDetail; onClose: () => void; onSendInvites: () => void }) {
  const { toast } = useApp()
  const [res, setRes] = useState<TakeoffAnalysisResult | null>(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string>('')
  const [applied, setApplied] = useState<{ created: number; updated: number } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    leopardApi
      .importTakeoff(detail.job.id)
      .then((r) => {
        setRes(r)
        setChosen(new Set(r.packages.filter((p) => p.tradeName !== 'Unassigned').map((p) => p.tradeName)))
      })
      .catch((e) => setError(e.message))
  }, [])

  const apply = async () => {
    if (!res) return
    setBusy(true)
    try {
      const list = res.packages.filter((p) => chosen.has(p.tradeName)).map((p) => ({ tradeName: p.existingTradeName || p.tradeName, csiCode: p.csiCode, lines: p.lines }))
      setApplied(await bid.applyTakeoffPackages(detail.job.id, list))
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const newCount = res ? res.packages.filter((p) => chosen.has(p.tradeName) && !p.existingTradeId).length : 0
  const updCount = res ? res.packages.filter((p) => chosen.has(p.tradeName) && p.existingTradeId).length : 0

  return (
    <Modal
      title={`Leopard takeoff · ${detail.job.leopard?.projectName ?? ''}`}
      onClose={onClose}
      width={820}
      className="lp-import"
      footer={
        applied ? (
          <>
            <span className="grow muted">Next: add companies to the new trades, then send the request for bids.</span>
            <Button onClick={onClose}>Close</Button>
            <Button kind="primary" icon="send" onClick={onSendInvites}>Send request for bids</Button>
          </>
        ) : (
          <>
            <span className="grow muted">{res ? `${chosen.size} of ${res.packages.length} trades selected` : ''}</span>
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="primary" icon="check" disabled={!res || !chosen.size || busy} onClick={apply}>
              {newCount && updCount ? `Create ${newCount} & update ${updCount} trades` : newCount ? `Create ${newCount} trade${newCount === 1 ? '' : 's'}` : `Update ${updCount} trade${updCount === 1 ? '' : 's'}`}
            </Button>
          </>
        )
      }
    >
      {error ? (
        <div className="error-box">{error}</div>
      ) : !res ? (
        <Spinner label="Getting the takeoff from Leopard..." />
      ) : applied ? (
        <div className="ok-box big">
          <Icon name="check" />
          <div>
            <b>{applied.created} trade{applied.created === 1 ? '' : 's'} created, {applied.updated} updated</b> with their takeoff quantities.
            <div>Request-for-bid emails can now include each trade's quantities: choose <b>Insert field &gt; Takeoff quantities</b>, or use the button in the send window.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="lp-summary">
            <span><b>{res.itemCount}</b> items</span>
            <span><b>{res.packages.length}</b> trades</span>
            {res.savedAt && <span className="muted">Takeoff saved in Leopard {ago(res.savedAt)}</span>}
          </div>
          <div className="muted small">
            Saved a copy {res.bidmailFile ? 'with the job files' : ''}{res.bidmailFile && res.leopardFile ? ' and ' : ''}{res.leopardFile ? <>in Leopard storage (<span className="mono">{res.leopardFile}</span>)</> : ''}.
          </div>
          {res.warnings.map((w) => <div key={w} className="warn-box small"><Icon name="alert" size={15} /> {w}</div>)}
          <div className="lp-packages">
            {res.packages.map((p) => (
              <div key={p.tradeName} className={cx('lp-pkg', chosen.has(p.tradeName) && 'on')}>
                <label className="lp-pkg-head">
                  <input
                    type="checkbox"
                    checked={chosen.has(p.tradeName)}
                    onChange={(e) => {
                      const n = new Set(chosen)
                      e.target.checked ? n.add(p.tradeName) : n.delete(p.tradeName)
                      setChosen(n)
                    }}
                  />
                  <span className="grow">
                    <b>{p.tradeName}</b> {p.csiCode && <span className="muted small mono">{p.csiCode}</span>}
                    <div className="small muted">{totalsText(p.totals) || 'No quantities'} · {p.lines.length} item{p.lines.length === 1 ? '' : 's'}</div>
                  </span>
                  <span className={cx('chip sm', p.existingTradeId ? '' : 'new')}>{p.existingTradeId ? `Updates ${p.existingTradeName}` : p.tradeName === 'Unassigned' ? 'No trade tag' : 'New trade'}</span>
                  <button className="link-btn small" onClick={(e) => { e.preventDefault(); setOpen(open === p.tradeName ? '' : p.tradeName) }}>{open === p.tradeName ? 'Hide' : 'Items'}</button>
                </label>
                {open === p.tradeName && <QtyTable lines={p.lines} projectId={res.projectId} />}
              </div>
            ))}
          </div>
          <p className="muted small">
            Trades come from each item's trade in Leopard, or its CSI code. Items without either are under "Unassigned"; tag them with a trade in Leopard and re-import.
          </p>
        </>
      )}
    </Modal>
  )
}

function QtyTable({ lines, projectId }: { lines: { description: string; quantity: number | null; unit: string; sheet: string; itemId?: string }[]; projectId?: string }) {
  return (
    <table className="qty-table">
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td>
              {l.description}
              {projectId && l.itemId && (
                <button className="icon-link" title="Show this item in Leopard" onClick={() => leopardApi.open(projectId, l.itemId)}>
                  <Icon name="external" size={12} />
                </button>
              )}
            </td>
            <td className="num">{l.quantity == null ? <span className="muted">-</span> : fmtQty(l.quantity, '')}</td>
            <td>{l.unit}</td>
            <td className="muted small">{l.sheet}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The job's takeoff quantities by trade (from the last Leopard import). */
export function TakeoffTab({ detail, onImport, onSendInvites }: { detail: JobDetail; onImport: () => void; onSendInvites: () => void }) {
  const withQty = detail.trades.filter((t) => t.takeoffLines.length)
  const link = detail.job.leopard
  if (!withQty.length)
    return (
      <Empty icon="grid" title="No takeoff quantities yet">
        <p>{link ? `Import the takeoff from "${link.projectName}" to see quantities by trade.` : 'Link this job to its Leopard project and import the takeoff to see quantities by trade.'}</p>
        <Button kind="primary" icon="download" onClick={onImport}>{link ? 'Import takeoff' : 'Link Leopard project'}</Button>
      </Empty>
    )
  return (
    <div className="takeoff-tab">
      <div className="toolbar">
        <span className="muted">
          {link?.takeoffImportedAt ? `From Leopard "${link.projectName}", imported ${fmtDateTime(link.takeoffImportedAt)}${link.takeoffImportedBy ? ` by ${link.takeoffImportedBy}` : ''}.` : 'Takeoff quantities by trade.'}
        </span>
        <span className="grow" />
        <Button icon="download" onClick={onImport}>{link ? 'Re-import' : 'Link Leopard project'}</Button>
        <Button kind="primary" icon="send" onClick={onSendInvites}>Send request for bids</Button>
      </div>
      {withQty.map((t) => {
        const totals: { unit: string; quantity: number }[] = []
        for (const l of t.takeoffLines) {
          if (l.quantity == null) continue
          const x = totals.find((y) => y.unit === l.unit)
          if (x) x.quantity += l.quantity
          else totals.push({ unit: l.unit, quantity: l.quantity })
        }
        return (
          <div key={t.id} className="card qty-card">
            <div className="qty-head">
              <b>{t.name}</b> {t.csiCode && <span className="muted small mono">{t.csiCode}</span>}
              <span className="grow" />
              <span className="small">{totalsText(totals)}</span>
              <span className="muted small">{t.bidders.length} compan{t.bidders.length === 1 ? 'y' : 'ies'}</span>
            </div>
            <QtyTable lines={t.takeoffLines} projectId={link?.projectId} />
          </div>
        )
      })}
    </div>
  )
}