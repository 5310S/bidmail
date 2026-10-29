import { useMemo, useState } from 'react'
import { Company, CompanyWithStats, expiresSoon } from '../../../shared/types'
import { companyWarnings } from '../jobs/TradeCard'
import { bid, sys } from '../api'
import { useApp, useBidQuery } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Field, Modal } from '../components/ui'
import { cx, fmtDate, fmtMoney, parseCsv, parseMoney } from '../util'

export const CERTIFICATIONS = ['MBE', 'WBE', 'DBE', 'SBE', 'VBE', 'SDVOSB', 'HUB', 'ACDBE', 'LBE']

const HEADER_MAP: Record<string, keyof Company> = {
  company: 'name', 'company name': 'name', name: 'name', subcontractor: 'name', vendor: 'name',
  contact: 'contactName', 'contact name': 'contactName', estimator: 'contactName',
  email: 'email', 'e-mail': 'email', 'email address': 'email',
  phone: 'phone', 'phone number': 'phone', telephone: 'phone', office: 'phone', cell: 'phone',
  trade: 'trades', trades: 'trades', 'csi division': 'trades', division: 'trades', scope: 'trades',
  notes: 'notes', note: 'notes', comments: 'notes',
  'gl expires': 'glExpires', 'gl expiration': 'glExpires', 'insurance expires': 'glExpires', 'liability expires': 'glExpires',
  'wc expires': 'wcExpires', 'wc expiration': 'wcExpires', 'workers comp expires': 'wcExpires',
  bonding: 'bondingLimit', 'bonding limit': 'bondingLimit', 'bonding capacity': 'bondingLimit',
  union: 'union', 'union status': 'union', certifications: 'certifications', certs: 'certifications', certification: 'certifications',
  license: 'license', 'license #': 'license', 'license number': 'license', prequalified: 'prequalified', prequal: 'prequalified'
}

/** Turns CSV text cells into typed company fields. */
function typed(o: Record<string, string>): Partial<Company> {
  const out: any = { ...o }
  for (const k of ['glExpires', 'wcExpires']) {
    if (o[k]) {
      const d = new Date(o[k])
      out[k] = isNaN(d.getTime()) ? null : d.toISOString()
    }
  }
  if ('bondingLimit' in o) out.bondingLimit = o.bondingLimit ? parseMoney(o.bondingLimit.replace(/m(illion)?\b/i, '000000')) : null
  if ('prequalified' in o) out.prequalified = /^(y|yes|true|1|x)$/i.test(o.prequalified.trim())
  if ('union' in o) out.union = /non/i.test(o.union) ? 'non_union' : /both|either/i.test(o.union) ? 'both' : /union|yes/i.test(o.union) ? 'union' : ''
  return out
}

export function CompaniesView() {
  const { toast, confirm, compose } = useApp()
  const { data: companies } = useBidQuery(() => bid.listCompanies(), [])
  const [q, setQ] = useState('')
  const [trade, setTrade] = useState('')
  const [cert, setCert] = useState('')
  const [prequalOnly, setPrequalOnly] = useState(false)
  const [insuranceIssues, setInsuranceIssues] = useState(false)
  const [editing, setEditing] = useState<Partial<Company> | null>(null)

  const allTrades = useMemo(() => {
    const s = new Set<string>()
    for (const c of companies ?? []) for (const t of c.trades.split(',')) if (t.trim()) s.add(t.trim())
    return [...s].sort()
  }, [companies])

  const list = (companies ?? []).filter((c) => {
    const s = q.trim().toLowerCase()
    if (trade && !c.trades.split(',').map((x) => x.trim()).includes(trade)) return false
    if (cert && !c.certifications.toUpperCase().split(/[,\s]+/).includes(cert)) return false
    if (prequalOnly && !c.prequalified) return false
    if (insuranceIssues && !expiresSoon(c.glExpires) && !expiresSoon(c.wcExpires)) return false
    return !s || [c.name, c.contactName, c.email, c.phone, c.trades].some((v) => v.toLowerCase().includes(s))
  })

  const importCsv = async () => {
    const text = await sys.openText()
    if (!text) return
    const rows = parseCsv(text)
    if (rows.length < 2) return toast('That file has no rows to import.', 'error')
    const headers = rows[0].map((h) => HEADER_MAP[h.trim().toLowerCase()])
    if (!headers.includes('name')) return toast('Could not find a "Company" column. The first row should have headers like Company, Contact, Email, Phone, Trade.', 'error')
    const data = rows.slice(1).map((r) => {
      const o: Record<string, string> = {}
      r.forEach((v, i) => {
        const k = headers[i]
        if (k) (o as any)[k] = (o as any)[k] ? `${(o as any)[k]}, ${v.trim()}` : v.trim()
      })
      return typed(o)
    })
    try {
      const res = await bid.importCompanies(data)
      toast(`Imported: ${res.added} added, ${res.updated} updated`, 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const exportCsv = async () => {
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US') : '')
    const lines = [
      'Company,Contact,Email,Phone,Trades,GL Expires,WC Expires,Bonding Limit,Union,Certifications,License,Prequalified,Invited,Priced,Notes',
      ...(companies ?? []).map((c) =>
        [c.name, c.contactName, c.email, c.phone, c.trades, d(c.glExpires), d(c.wcExpires), c.bondingLimit ?? '', c.union, c.certifications, c.license, c.prequalified ? 'yes' : '', c.invitedCount, c.pricedCount, c.notes]
          .map((v) => esc(String(v)))
          .join(',')
      )
    ]
    const p = await sys.saveText('BidMail Companies.csv', lines.join('\r\n'))
    if (p) toast('Exported to ' + p, 'success')
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Companies</h1>
          <div className="muted">Your subcontractor & supplier directory, shared across jobs. {companies?.length ?? 0} companies.</div>
        </div>
        <span className="grow" />
        <Button icon="upload" onClick={importCsv} title="Import from a CSV/Excel export">Import CSV</Button>
        <Button icon="download" onClick={exportCsv} disabled={!companies?.length}>Export</Button>
        <Button kind="primary" icon="plus" onClick={() => setEditing({})}>Add Company</Button>
      </div>
      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, contact, email, trade" />
        </div>
        <select value={trade} onChange={(e) => setTrade(e.target.value)}>
          <option value="">All trades</option>
          {allTrades.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={cert} onChange={(e) => setCert(e.target.value)}>
          <option value="">Any certification</option>
          {CERTIFICATIONS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={prequalOnly} onChange={(e) => setPrequalOnly(e.target.checked)} /> Prequalified only</label>
        <label className="check"><input type="checkbox" checked={insuranceIssues} onChange={(e) => setInsuranceIssues(e.target.checked)} /> Insurance expired / expiring</label>
      </div>
      {list.length === 0 ? (
        <Empty icon="building" title={companies?.length ? 'No matches' : 'No companies yet'}>
          {!companies?.length && (
            <p>
              Add the subs you invite to bid, or <button className="link-btn" onClick={importCsv}>import a CSV</button> with columns
              like <i>Company, Contact, Email, Phone, Trade</i> (save your Excel list as CSV).
            </p>
          )}
        </Empty>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Company</th><th>Contact</th><th>Email / Phone</th><th>Trades</th><th>Prequalification</th><th title="Prices sent back vs. invitations, across all jobs">Bids back</th><th style={{ width: 110 }} /></tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} onDoubleClick={() => setEditing(c)}>
                <td><b>{c.name}</b>{c.notes && <div className="muted small ellipsis" style={{ maxWidth: 260 }}>{c.notes}</div>}</td>
                <td>{c.contactName}</td>
                <td>{c.email}<div className="muted small">{c.phone}</div></td>
                <td>{c.trades.split(',').filter((t) => t.trim()).map((t) => <span key={t} className="tag">{t.trim()}</span>)}</td>
                <td><PrequalBadges c={c} /></td>
                <td className="nowrap">{c.invitedCount ? <span className={cx(c.pricedCount / c.invitedCount < 0.3 && 'err')} title={`Priced ${c.pricedCount} of ${c.invitedCount} invitations; declined ${c.declinedCount}`}>{Math.round((c.pricedCount / c.invitedCount) * 100)}% <span className="muted small">({c.pricedCount}/{c.invitedCount})</span></span> : <span className="muted">-</span>}</td>
                <td className="row-actions">
                  <Button small kind="ghost" icon="mail" title="Email" disabled={!c.email} onClick={() => compose({ to: c.contactName ? `${c.contactName} <${c.email.split(/[;,\s]+/)[0]}>` : c.email })} />
                  <Button small kind="ghost" icon="edit" title="Edit" onClick={() => setEditing(c)} />
                  <Button
                    small
                    kind="ghost"
                    icon="trash"
                    title="Delete"
                    onClick={async () => {
                      if (await confirm({ title: 'Delete company?', message: `Delete ${c.name} from the directory? It stays on any jobs it was already added to.` }))
                        bid.deleteCompany(c.id)
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <CompanyForm company={editing} trades={allTrades} onClose={() => setEditing(null)} />}
    </div>
  )
}

function PrequalBadges({ c }: { c: CompanyWithStats }) {
  const warns = companyWarnings(c)
  return (
    <span className="badges">
      {c.prequalified && <span className="tag ok">Prequalified</span>}
      {warns.length > 0 && <span className="tag bad" title={warns.join('\n')}>{warns.some((w) => w.includes('expired')) ? 'Insurance expired' : 'Insurance expiring'}</span>}
      {c.certifications.split(/[,\s]+/).filter(Boolean).map((x) => <span key={x} className="tag cert">{x}</span>)}
      {c.union && <span className="tag">{c.union === 'union' ? 'Union' : c.union === 'non_union' ? 'Non-union' : 'Union & non-union'}</span>}
      {c.bondingLimit != null && <span className="tag" title="Bonding capacity">Bond {fmtMoney(c.bondingLimit)}</span>}
    </span>
  )
}

function CompanyForm({ company, trades, onClose }: { company: Partial<Company>; trades: string[]; onClose: () => void }) {
  const { toast } = useApp()
  const dateIn = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : '')
  const [f, setF] = useState({
    name: company.name ?? '', contactName: company.contactName ?? '', email: company.email ?? '',
    phone: company.phone ?? '', trades: company.trades ?? '', notes: company.notes ?? '',
    glExpires: dateIn(company.glExpires), wcExpires: dateIn(company.wcExpires),
    bondingLimit: company.bondingLimit != null ? fmtMoney(company.bondingLimit) : '', union: company.union ?? '',
    certifications: company.certifications ?? '', license: company.license ?? '', prequalified: !!company.prequalified
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }))
  const certs = new Set(f.certifications.split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase()))
  const toggleCert = (x: string) => {
    const n = new Set(certs)
    if (n.has(x)) n.delete(x)
    else n.add(x)
    setF({ ...f, certifications: [...n].join(', ') })
  }
  const save = async () => {
    if (!f.name.trim()) return toast('Enter a company name.', 'error')
    try {
      await bid.saveCompany({
        ...company, ...f,
        glExpires: f.glExpires ? new Date(f.glExpires + 'T12:00:00').toISOString() : null,
        wcExpires: f.wcExpires ? new Date(f.wcExpires + 'T12:00:00').toISOString() : null,
        bondingLimit: f.bondingLimit.trim() ? parseMoney(f.bondingLimit) : null,
        union: f.union as Company['union']
      })
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  const gl = expiresSoon(f.glExpires ? new Date(f.glExpires).toISOString() : null)
  const wc = expiresSoon(f.wcExpires ? new Date(f.wcExpires).toISOString() : null)
  return (
    <Modal title={company.id ? 'Edit company' : 'Add company'} onClose={onClose} width={720} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Company" wide><input autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Contact / estimator"><input value={f.contactName} onChange={set('contactName')} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email (separate several with commas)" wide><input value={f.email} onChange={set('email')} /></Field>
        <Field label="Trades (comma separated)" wide hint={trades.length ? `Existing: ${trades.slice(0, 12).join(', ')}${trades.length > 12 ? '...' : ''}` : 'e.g. Electrical, Fire Alarm'}>
          <input value={f.trades} onChange={set('trades')} />
        </Field>
      </div>
      <h3 className="form-section">Prequalification</h3>
      <div className="form-grid">
        <Field label="General liability insurance expires" hint={gl === 'expired' ? <span className="err">Expired</span> : gl === 'soon' ? <span className="warn-text">Expires within 30 days</span> : undefined}>
          <input type="date" value={f.glExpires} onChange={set('glExpires')} />
        </Field>
        <Field label="Workers' comp expires" hint={wc === 'expired' ? <span className="err">Expired</span> : wc === 'soon' ? <span className="warn-text">Expires within 30 days</span> : undefined}>
          <input type="date" value={f.wcExpires} onChange={set('wcExpires')} />
        </Field>
        <Field label="Bonding capacity"><input value={f.bondingLimit} onChange={set('bondingLimit')} placeholder="$2,000,000" /></Field>
        <Field label="Labor">
          <select value={f.union} onChange={set('union')}>
            <option value="">Not specified</option>
            <option value="union">Union</option>
            <option value="non_union">Non-union</option>
            <option value="both">Both</option>
          </select>
        </Field>
        <Field label="Contractor license #"><input value={f.license} onChange={set('license')} /></Field>
        <label className="check"><input type="checkbox" checked={f.prequalified} onChange={(e) => setF({ ...f, prequalified: e.target.checked })} /> Prequalified with us</label>
        <div className="field-wide">
          <div className="field-label">Certifications</div>
          <div className="cert-pick">
            {CERTIFICATIONS.map((x) => <button key={x} type="button" className={cx('chip', certs.has(x) && 'on')} onClick={() => toggleCert(x)}>{x}</button>)}
          </div>
        </div>
        <Field label="Notes" wide><textarea rows={3} value={f.notes} onChange={set('notes')} /></Field>
      </div>
      {company.id && <p className="muted small">Last updated {fmtDate(company.updatedAt)}</p>}
    </Modal>
  )
}