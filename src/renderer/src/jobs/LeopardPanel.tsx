// Leopard on a job: link the job to its Leopard project, import the takeoff (a copy is saved with the job and in
// Leopard's storage), and turn the quantities into trades for request-for-bid emails.
import { useEffect, useState } from 'react'
import type { LeopardCheck, LeopardProjectInfo, LeopardStatus, TakeoffAnalysisResult } from '../../../shared/ipc'
import type { CompanyWithStats, JobDetail } from '../../../shared/types'
import { companiesForTrade } from '../../../shared/vendorList'
import { fmtQty } from '../../../shared/takeoffAnalysis'
import { bid, leopardApi, vendors } from '../api'
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
  // Is the imported takeoff still what's in Leopard? Checked when the job opens and after each import.
  const [check, setCheck] = useState<LeopardCheck | null>(null)
  useEffect(() => {
    if (!link || !signedIn) return setCheck(null)
    let live = true
    leopardApi.check(detail.job.id).then((c) => live && setCheck(c)).catch(() => {})
    return () => {
      live = false
    }
  }, [link?.projectId, link?.takeoffSavedAt, link?.takeoffImportedAt, signedIn])
  const changed = check?.state === 'changed'
  const lost = check?.state === 'gone' || check?.state === 'deleted'

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
            {changed && (
              <div className="lp-note warn" title={check?.takeoffSaved ? `Saved in Leopard ${ago(check.takeoffSaved)}` : ''}>
                <Icon name="alert" size={13} /> Takeoff changed in Leopard{check?.takeoffSaved ? ` ${ago(check.takeoffSaved)}` : ''}
              </div>
            )}
            {lost && <div className="lp-note warn"><Icon name="alert" size={13} /> {check?.message}</div>}
            {check?.state === 'current' && <div className="lp-note ok"><Icon name="check" size={13} /> Up to date with Leopard</div>}
            <div className="lp-actions">
              {lost ? (
                <Button small kind="primary" icon="link" onClick={() => setPicking(true)}>Link again</Button>
              ) : (
                <Button small kind={!link.takeoffImportedAt || changed ? 'primary' : 'default'} icon="download" onClick={() => (signedIn ? setImporting(true) : needSignIn())}>
                  {link.takeoffImportedAt ? 'Re-import' : 'Import takeoff'}
                </Button>
              )}
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

  return (
    <Modal
      title={`Link a Leopard project · ${job.name}`}
      onClose={onClose}
      width={620}
      footer={<Button onClick={onClose}>Cancel</Button>}

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
          {list.length === 0 && <Empty icon="grid" title="No projects in Leopard yet">Start the takeoff in Leopard, then link it here.</Empty>}
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
  const [companies, setCompanies] = useState<CompanyWithStats[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [picks, setPicks] = useState<Record<string, string[]>>({})
  const [open, setOpen] = useState<{ trade: string; what: 'items' | 'companies' } | null>(null)
  const [applied, setApplied] = useState<{ created: number; updated: number; companies: number } | null>(null)
  const [busy, setBusy] = useState(false)

  // Companies already on a trade of this job (by company or email) aren't added twice.
  const onTrade = (tradeId: string | null) => {
    const t = tradeId ? detail.trades.find((x) => x.id === tradeId) : undefined
    return { ids: new Set(t?.bidders.map((b) => b.companyId).filter(Boolean) as string[]), emails: new Set(t?.bidders.map((b) => b.email.toLowerCase()).filter(Boolean)) }
  }
  const suggest = (r: TakeoffAnalysisResult, list: CompanyWithStats[]) => {
    const out: Record<string, string[]> = {}
    for (const p of r.packages) {
      const have = onTrade(p.existingTradeId)
      out[p.tradeName] = companiesForTrade(list, p.existingTradeName || p.tradeName, p.csiCode)
        .filter((c) => c.email && !have.ids.has(c.id) && !have.emails.has(c.email.toLowerCase()))
        .map((c) => c.id)
    }
    return out
  }
  useEffect(() => {
    Promise.all([leopardApi.importTakeoff(detail.job.id), bid.listCompanies()])
      .then(([r, list]) => {
        setRes(r)
        setCompanies(list)
        setChosen(new Set(r.packages.filter((p) => p.tradeName !== 'Unassigned').map((p) => p.tradeName)))
        setPicks(suggest(r, list))
      })
      .catch((e) => setError(e.message))
  }, [])

  const loadVendorList = async () => {
    try {
      const r = await vendors.import()
      if (!r) return
      const list = await bid.listCompanies()
      setCompanies(list)
      if (res) setPicks(suggest(res, list))
      toast(`Vendor list: ${r.total} companies in ${r.trades} trades`, 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const apply = async () => {
    if (!res) return
    setBusy(true)
    try {
      const list = res.packages
        .filter((p) => chosen.has(p.tradeName))
        .map((p) => ({ tradeName: p.existingTradeName || p.tradeName, csiCode: p.csiCode, lines: p.lines, companyIds: picks[p.tradeName] ?? [] }))
      setApplied(await bid.applyTakeoffPackages(detail.job.id, list))
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const byId = new Map((companies ?? []).map((c) => [c.id, c]))
  const selectedCompanies = res ? res.packages.filter((p) => chosen.has(p.tradeName)).reduce((n, p) => n + (picks[p.tradeName]?.length ?? 0), 0) : 0
  const tradeCount = chosen.size

  return (
    <Modal
      title={`Leopard takeoff · ${detail.job.leopard?.projectName ?? ''}`}
      onClose={onClose}
      width={860}
      className="lp-import"
      footer={
        applied ? (
          <>
            <span className="grow" />
            <Button onClick={onClose}>Close</Button>
            <Button kind="primary" icon="send" onClick={onSendInvites}>Send request for bids</Button>
          </>
        ) : (
          <>
            <span className="grow muted">{res ? `${tradeCount} of ${res.packages.length} trades · ${selectedCompanies} companies` : ''}</span>
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="primary" icon="check" disabled={!res || !tradeCount || busy} onClick={apply}>
              Set up {tradeCount} trade{tradeCount === 1 ? '' : 's'}{selectedCompanies ? ` & ${selectedCompanies} compan${selectedCompanies === 1 ? 'y' : 'ies'}` : ''}
            </Button>
          </>
        )
      }
    >
      {error ? (
        <div className="error-box">{error}</div>
      ) : !res || !companies ? (
        <Spinner label="Getting the takeoff from Leopard..." />
      ) : applied ? (
        <div className="ok-box big">
          <Icon name="check" />
          <div>
            <b>
              {applied.created + applied.updated} trade{applied.created + applied.updated === 1 ? '' : 's'} set up with their takeoff quantities
              {applied.companies ? `, ${applied.companies} compan${applied.companies === 1 ? 'y' : 'ies'} added from your vendor list` : ''}.
            </b>
            <div>Next: <b>Send request for bids</b>. Each company's email lists the quantities for its own trade.</div>
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
          {companies.length === 0 && (
            <div className="warn-box">
              <Icon name="users" size={16} />
              <span className="grow">Import your vendor list (Excel) so BidMail can pick the companies for each trade.</span>
              <button className="link-btn" onClick={loadVendorList}>Import vendor list</button>
            </div>
          )}
          <div className="lp-packages">
            {res.packages.map((p) => {
              const ids = picks[p.tradeName] ?? []
              const isOpen = (what: 'items' | 'companies') => open?.trade === p.tradeName && open.what === what
              const toggle = (what: 'items' | 'companies') => setOpen(isOpen(what) ? null : { trade: p.tradeName, what })
              const others = companies.filter((c) => !ids.includes(c.id)).sort((a, b) => a.trades.localeCompare(b.trades) || a.name.localeCompare(b.name))
              return (
                <div key={p.tradeName} className={cx('lp-pkg', chosen.has(p.tradeName) && 'on')}>
                  <div className="lp-pkg-head">
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
                      <b>{p.existingTradeName || p.tradeName}</b> {p.csiCode && <span className="muted small mono">{p.csiCode}</span>}
                      <div className="small muted">{totalsText(p.totals) || 'No quantities'} · {p.lines.length} item{p.lines.length === 1 ? '' : 's'}</div>
                    </span>
                    {p.tradeName === 'Unassigned' && <span className="chip sm">No trade tag</span>}
                    <button className={cx('lp-cos', !ids.length && 'none')} onClick={() => toggle('companies')}>
                      <Icon name="users" size={13} /> {ids.length ? `${ids.length} compan${ids.length === 1 ? 'y' : 'ies'}` : 'No companies'}
                    </button>
                    <button className="link-btn small" onClick={() => toggle('items')}>{isOpen('items') ? 'Hide' : 'Items'}</button>
                  </div>
                  {isOpen('items') && <QtyTable lines={p.lines} projectId={res.projectId} />}
                  {isOpen('companies') && (
                    <div className="lp-company-list">
                      {ids.length === 0 && <div className="muted small">No companies in your vendor list for this trade. Add one below.</div>}
                      {ids.map((id) => {
                        const c = byId.get(id)
                        if (!c) return null
                        return (
                          <label key={id} className="check">
                            <input type="checkbox" checked onChange={() => setPicks({ ...picks, [p.tradeName]: ids.filter((x) => x !== id) })} />
                            <b>{c.name}</b> <span className="muted small">{c.contactName ? c.contactName + ' · ' : ''}{c.email || 'no email'} · {c.trades}{c.certifications ? ' · ' + c.certifications : ''}</span>
                          </label>
                        )
                      })}
                      {others.length > 0 && (
                        <select value="" onChange={(e) => e.target.value && setPicks({ ...picks, [p.tradeName]: [...ids, e.target.value] })}>
                          <option value="">+ Add a company...</option>
                          {others.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.trades || 'no trade'})</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <p className="muted small">
            Trades come from each item's trade in Leopard, or its CSI code; companies come from your vendor list by their Category.
            {companies.length > 0 && <> <button className="link-btn small" onClick={loadVendorList}>Re-import vendor list</button></>}
          </p>
        </>
      )}
    </Modal>
  )
}
function QtyTable({ lines, projectId }: { lines: { description: string; quantity: number | null; unit: string; sheet: string; itemId?: string; quantityText?: string }[]; projectId?: string }) {
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
            <td className="num">{l.quantity == null ? (l.quantityText ? l.quantityText : <span className="muted">-</span>) : fmtQty(l.quantity, '')}</td>
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