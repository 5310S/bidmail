// Bid leveling: compare subs on the same scope. Base price + plug amounts for anything a sub excluded
// + accepted alternates = leveled total. The true low bid is often not the lowest number on paper.
import { useEffect, useState } from 'react'
import { randomId } from '../util'
import { Bidder, JobDetail, leveledTotal, ScopeMark, TradeWithBidders } from '../../../shared/types'
import { bid } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Field, Modal } from '../components/ui'
import { cx, fmtMoney, parseMoney } from '../util'
import { QuoteFiles } from './QuoteFiles'

export function LevelingTab({ detail }: { detail: JobDetail }) {
  const { toast } = useApp()
  const tradesWithPrices = detail.trades.filter((t) => t.bidders.some((b) => b.priceReceivedAt || b.willBidAt))
  const [tradeId, setTradeId] = useState(tradesWithPrices[0]?.id ?? detail.trades[0]?.id ?? '')
  const trade = detail.trades.find((t) => t.id === tradeId)
  const [newItem, setNewItem] = useState('')
  const [quote, setQuote] = useState<Bidder | null>(null)

  if (!detail.trades.length) return <Empty icon="grid" title="Add trades first" />
  const job = detail.job

  const setAlternates = (alts: typeof job.alternates) => bid.updateJob(job.id, { alternates: alts }).catch((e) => toast(e.message, 'error'))
  const addItem = () => {
    if (!trade || !newItem.trim()) return
    bid.updateTrade(trade.id, { scopeItems: [...trade.scopeItems, newItem.trim()] })
    setNewItem('')
  }

  return (
    <div className="leveling">
      <div className="toolbar">
        <span className="field-label">Trade:</span>
        <div className="filter-chips">
          {detail.trades.map((t) => {
            const n = t.bidders.filter((b) => b.priceReceivedAt).length
            return (
              <button key={t.id} className={cx('chip', t.id === tradeId && 'on')} onClick={() => setTradeId(t.id)}>
                {t.name}{n ? ` (${n})` : ''}
              </button>
            )
          })}
        </div>
      </div>

      <AlternatesEditor job={job} onChange={setAlternates} />

      {trade && <LevelingGrid key={trade.id} detail={detail} trade={trade} onQuote={setQuote} />}

      {trade && (
        <form className="add-scope" onSubmit={(e) => { e.preventDefault(); addItem() }}>
          <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder={`Add a scope item to check for ${trade.name} (e.g. "Fire alarm", "Permits")`} />
          <Button type="submit" icon="plus" disabled={!newItem.trim()}>Add scope item</Button>
        </form>
      )}
      {quote && trade && <QuoteDetails b={quote} detail={detail} onClose={() => setQuote(null)} />}
    </div>
  )
}

function AlternatesEditor({ job, onChange }: { job: JobDetail['job']; onChange: (a: JobDetail['job']['alternates']) => void }) {
  const [name, setName] = useState('')
  return (
    <div className="alternates card">
      <div className="field-label">Bid alternates (from the bid form)</div>
      <div className="alt-list">
        {job.alternates.map((a) => (
          <span key={a.id} className={cx('alt-chip', a.accepted && 'on')}>
            <label className="check" title="Include this alternate in leveled totals">
              <input type="checkbox" checked={a.accepted} onChange={(e) => onChange(job.alternates.map((x) => (x.id === a.id ? { ...x, accepted: e.target.checked } : x)))} />
              {a.name}
            </label>
            <button title="Remove" onClick={() => onChange(job.alternates.filter((x) => x.id !== a.id))}><Icon name="x" size={12} /></button>
          </span>
        ))}
        <form
          className="alt-add"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            onChange([...job.alternates, { id: randomId(), name: name.trim(), accepted: false }])
            setName('')
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Alternate ${job.alternates.length + 1}: e.g. LED upgrade`} />
          <Button small type="submit" icon="plus" disabled={!name.trim()}>Add</Button>
        </form>
      </div>
      {job.alternates.length > 0 && <div className="muted small">Checked alternates are added to every sub's leveled total.</div>}
    </div>
  )
}

function MoneyInput({ value, onSave, placeholder }: { value: number | null | undefined; onSave: (v: number | null) => void; placeholder?: string }) {
  const show = (n: number | null | undefined) => (n != null ? fmtMoney(n) : '')
  const [v, setV] = useState(show(value))
  useEffect(() => setV(show(value)), [value])
  return (
    <input
      className="money"
      value={v}
      placeholder={placeholder ?? '$'}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = v.trim() ? parseMoney(v) : null
        if (n !== (value ?? null)) onSave(n)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function LevelingGrid({ detail, trade, onQuote }: { detail: JobDetail; trade: TradeWithBidders; onQuote: (b: Bidder) => void }) {
  const { toast } = useApp()
  const job = detail.job
  const cols = trade.bidders.filter((b) => !b.declinedAt && (b.priceReceivedAt || b.willBidAt || b.priceAmount != null))
  if (!cols.length) return <Empty icon="dollar" title={`No prices for ${trade.name} yet`}>Companies appear here once they have a price or are marked "Will Bid".</Empty>
  const totals = cols.map((b) => leveledTotal(b, trade, job))
  const valid = totals.filter((t): t is number => t != null)
  const low = valid.length ? Math.min(...valid) : null
  const paperLow = Math.min(...cols.map((b) => b.priceAmount ?? Infinity))

  const setMark = (b: Bidder, item: string, mark: Partial<ScopeMark>) => {
    const cur = b.scope[item] ?? { status: 'unknown', plug: null }
    bid.updateBidder(b.id, { scope: { ...b.scope, [item]: { ...cur, ...mark } } }).catch((e) => toast(e.message, 'error'))
  }
  const removeItem = (item: string) => bid.updateTrade(trade.id, { scopeItems: trade.scopeItems.filter((i) => i !== item) })

  return (
    <div className="level-wrap">
      <table className="level-table">
        <thead>
          <tr>
            <th className="lv-label">{trade.name}</th>
            {cols.map((b) => (
              <th key={b.id}>
                <div className="lv-company">{b.companyName}</div>
                <button className="link-btn small" onClick={() => onQuote(b)}><Icon name="edit" size={12} /> Quote details</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="lv-base">
            <td className="lv-label">Base bid</td>
            {cols.map((b) => (
              <td key={b.id} className={cx('num', b.priceAmount === paperLow && cols.length > 1 && 'paper-low')}>
                <MoneyInput value={b.priceAmount} onSave={(v) => (b.priceReceivedAt ? bid.updateBidder(b.id, { priceAmount: v }) : bid.bidderAction(b.id, 'price_received', { amount: v }))} />
              </td>
            ))}
          </tr>
          <tr>
            <td className="lv-label">Includes</td>
            {cols.map((b) => <td key={b.id} className="lv-text" title={b.inclusions}>{b.inclusions || <span className="muted">-</span>}</td>)}
          </tr>
          <tr>
            <td className="lv-label">Excludes</td>
            {cols.map((b) => <td key={b.id} className="lv-text err-soft" title={b.exclusions}>{b.exclusions || <span className="muted">-</span>}</td>)}
          </tr>
          {trade.scopeItems.length > 0 && (
            <tr className="lv-group"><td colSpan={cols.length + 1}>Scope check: is it in their number? Add a plug for what's missing.</td></tr>
          )}
          {trade.scopeItems.map((item) => (
            <tr key={item}>
              <td className="lv-label">
                {item}
                <button className="lv-remove" title="Remove item" onClick={() => removeItem(item)}><Icon name="x" size={11} /></button>
              </td>
              {cols.map((b) => {
                const m = b.scope[item] ?? { status: 'unknown', plug: null }
                return (
                  <td key={b.id} className={cx('lv-scope', `sc-${m.status}`)}>
                    <select value={m.status} onChange={(e) => setMark(b, item, { status: e.target.value as ScopeMark['status'] })}>
                      <option value="unknown">? Not sure</option>
                      <option value="included">Included</option>
                      <option value="excluded">Excluded</option>
                    </select>
                    {m.status === 'excluded' && <MoneyInput value={m.plug} placeholder="+ plug $" onSave={(v) => setMark(b, item, { plug: v })} />}
                  </td>
                )
              })}
            </tr>
          ))}
          {job.alternates.length > 0 && <tr className="lv-group"><td colSpan={cols.length + 1}>Alternates</td></tr>}
          {job.alternates.map((a) => (
            <tr key={a.id} className={cx(!a.accepted && 'lv-dim')}>
              <td className="lv-label">{a.name}{a.accepted ? '' : ' (not included)'}</td>
              {cols.map((b) => (
                <td key={b.id} className="num">
                  <MoneyInput value={b.alternatePrices[a.id]} placeholder="add / deduct $" onSave={(v) => bid.updateBidder(b.id, { alternatePrices: { ...b.alternatePrices, [a.id]: v } })} />
                </td>
              ))}
            </tr>
          ))}
          <tr className="lv-total">
            <td className="lv-label">Leveled total</td>
            {cols.map((b, i) => (
              <td key={b.id} className={cx('num', totals[i] != null && totals[i] === low && cols.length > 1 && 'is-low')}>
                {totals[i] != null ? fmtMoney(totals[i]) : <span className="muted">no price</span>}
                {totals[i] != null && totals[i] === low && cols.length > 1 && <span className="low-badge">LOW</span>}
                {totals[i] != null && low != null && totals[i]! > low && <div className="muted small">+{fmtMoney(totals[i]! - low)}</div>}
              </td>
            ))}
          </tr>
          <tr>
            <td className="lv-label">Quote files</td>
            {cols.map((b) => <td key={b.id}><QuoteFiles jobId={job.id} bidderId={b.id} list={detail.files} compact /></td>)}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function QuoteDetails({ b, detail, onClose }: { b: Bidder; detail: JobDetail; onClose: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({ inclusions: b.inclusions, exclusions: b.exclusions, quoteNotes: b.quoteNotes })
  const save = async () => {
    try {
      await bid.updateBidder(b.id, f)
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <Modal title={`${b.companyName}: quote details`} onClose={onClose} width={640} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Inclusions" wide><textarea rows={3} value={f.inclusions} onChange={(e) => setF({ ...f, inclusions: e.target.value })} placeholder="What their number includes" /></Field>
        <Field label="Exclusions" wide><textarea rows={3} value={f.exclusions} onChange={(e) => setF({ ...f, exclusions: e.target.value })} placeholder="What they excluded (fire alarm, permits, bonds...)" /></Field>
        <Field label="Notes / qualifications" wide><textarea rows={2} value={f.quoteNotes} onChange={(e) => setF({ ...f, quoteNotes: e.target.value })} placeholder="Valid 30 days, lead times, assumptions..." /></Field>
        <div className="field-wide">
          <div className="field-label">Quote files</div>
          <QuoteFiles jobId={detail.job.id} bidderId={b.id} list={detail.files} />
        </div>
      </div>
    </Modal>
  )
}