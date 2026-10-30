// Board: one column per workflow step, one card per company. A card sits in the column of the furthest
// step it has completed. Drag a card to a column to complete that step; click it for the full checklist.
import { useState } from 'react'
import { Bidder, furthestStep, JobDetail, stepState, WorkflowStep } from '../../../shared/types'
import { bid } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Modal } from '../components/ui'
import { cx, fmtDateTime, parseMoney } from '../util'
import { completeStep, STEP_COLORS, StepChecklist, useWorkflow } from './workflow'

interface Card {
  b: Bidder
  tradeName: string
}

export function BoardTab({ detail }: { detail: JobDetail }) {
  const { toast, go } = useApp()
  const { steps, workflow } = useWorkflow()
  const [trade, setTrade] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [pricePrompt, setPricePrompt] = useState<{ b: Bidder; step: WorkflowStep } | null>(null)
  const [amount, setAmount] = useState('')

  if (!workflow) return null
  const cards: Card[] = detail.trades
    .filter((t) => !trade || t.id === trade)
    .flatMap((t) => t.bidders.map((b) => ({ b, tradeName: t.name })))
    .filter(({ b }) => !q || [b.companyName, b.contactName].some((v) => v.toLowerCase().includes(q.toLowerCase())))
  if (!detail.trades.some((t) => t.bidders.length)) return <Empty icon="grid" title="No companies yet">Add companies to trades, then track them here step by step.</Empty>

  const columns: { id: string; name: string; step?: WorkflowStep; color: string }[] = [
    { id: '__start', name: 'Not started', color: '#9aa4b2' },
    ...steps.map((s) => ({ id: s.id, name: s.name, step: s, color: STEP_COLORS[s.kind] })),
    { id: '__declined', name: 'Not bidding', color: '#b8312a' }
  ]
  const colOf = (b: Bidder) => (b.declinedAt ? '__declined' : furthestStep(b, steps, detail.files) < 0 ? '__start' : steps[furthestStep(b, steps, detail.files)].id)
  const openCard = cards.find((c) => c.b.id === open)

  const drop = async (colId: string) => {
    setOver(null)
    const card = cards.find((c) => c.b.id === dragId)
    setDragId(null)
    if (!card || colOf(card.b) === colId) return
    const col = columns.find((c) => c.id === colId)!
    try {
      if (colId === '__declined') await bid.bidderAction(card.b.id, 'declined')
      else if (colId === '__start') toast('To move a card back, open it and untick steps.', 'info')
      else if (col.step && !stepState(card.b, col.step, detail.files).done) {
        if (col.step.kind === 'price_received') {
          setAmount('')
          setPricePrompt({ b: card.b, step: col.step })
        } else {
          if (card.b.declinedAt) await bid.bidderAction(card.b.id, 'clear_declined')
          await completeStep(card.b, col.step)
          toast(`${card.b.companyName}: ${col.step.name}`, 'success')
        }
      }
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="board-view">
      <div className="toolbar">
        <select value={trade} onChange={(e) => setTrade(e.target.value)}>
          <option value="">All trades</option>
          {detail.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a company" /></div>
        <span className="muted small grow">Drag a card to a column to complete that step. Click a card for every step, with who and when.</span>
        <Button small icon="settings" onClick={() => go({ kind: 'settings', tab: 'workflow' })}>Customize steps</Button>
      </div>
      <div
        className="kanban"
        onDragOver={(e) => {
          // Scroll sideways when dragging near the edge, so every column can be reached.
          const el = e.currentTarget
          const r = el.getBoundingClientRect()
          if (e.clientX > r.right - 70) el.scrollLeft += 18
          else if (e.clientX < r.left + 70) el.scrollLeft -= 18
        }}
      >
        {columns.map((col) => {
          const inCol = cards.filter((c) => colOf(c.b) === col.id)
          return (
            <div
              key={col.id}
              className={cx('kan-col', over === col.id && 'over')}
              onDragOver={(e) => { e.preventDefault(); setOver(col.id) }}
              onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(col.id) }}
            >
              <div className="kan-head" style={{ borderTopColor: col.color }}>
                <b>{col.name}</b> <span className="count-pill" style={{ background: col.color }}>{inCol.length}</span>
              </div>
              <div className="kan-cards">
                {inCol.map(({ b, tradeName }) => {
                  const done = steps.filter((s) => stepState(b, s, detail.files).done)
                  const last = col.step ? stepState(b, col.step, detail.files) : null
                  return (
                    <div
                      key={b.id}
                      className={cx('kan-card', dragId === b.id && 'dragging')}
                      draggable
                      onDragStart={() => setDragId(b.id)}
                      onDragEnd={() => { setDragId(null); setOver(null) }}
                      onClick={() => setOpen(b.id)}
                    >
                      <div className="kan-company">{b.companyName}</div>
                      <div className="muted small">{tradeName}{b.contactName ? ` · ${b.contactName}` : ''}</div>
                      <div className="kan-dots">
                        {steps.map((s) => <span key={s.id} title={s.name} className="kan-dot" style={{ background: done.includes(s) ? STEP_COLORS[s.kind] : undefined, borderColor: STEP_COLORS[s.kind] }} />)}
                      </div>
                      {last?.done && <div className="muted small">{fmtDateTime(last.at)}{last.by ? ` · ${last.by}` : ''}</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      {openCard && (
        <Modal title={`${openCard.b.companyName} · ${openCard.tradeName}`} onClose={() => setOpen(null)} width={520}>
          <StepChecklist b={openCard.b} steps={steps} files={detail.files} jobId={detail.job.id} />
        </Modal>
      )}
      {pricePrompt && (
        <Modal title={`Price from ${pricePrompt.b.companyName}`} onClose={() => setPricePrompt(null)} width={380}
          footer={<><Button onClick={() => setPricePrompt(null)}>Cancel</Button><Button kind="success" onClick={() => {
            completeStep(pricePrompt.b, pricePrompt.step, amount.trim() ? parseMoney(amount) : null).catch((e) => toast(e.message, 'error'))
            setPricePrompt(null)
          }}>Save</Button></>}>
          <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount $ (optional)" style={{ width: '100%' }} />
        </Modal>
      )}
    </div>
  )
}