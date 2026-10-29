// The per-company status cells: Drawings Sent, Follow-Up, Price. Each records date & time.
import { useState } from 'react'
import type { Bidder, BidderAction } from '../../../shared/types'
import { bid } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Popover } from '../components/ui'
import { fmtDateTime, fmtMoney, fromLocalInput, parseMoney, toLocalInput } from '../util'

function useAct() {
  const { toast } = useApp()
  return async (id: string, action: BidderAction, input: { at?: string; note?: string; amount?: number | null } = {}) => {
    try {
      await bid.bidderAction(id, action, input)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
}

export function DrawingsCell({ b, onEmail }: { b: Bidder; onEmail: () => void }) {
  const act = useAct()
  const [pop, setPop] = useState<DOMRect | null>(null)
  const [at, setAt] = useState('')
  if (!b.drawingsSentAt) {
    return (
      <div className="cp-cell">
        <button className="cp-btn" onClick={() => act(b.id, 'drawings_sent')} title="Mark drawings as sent now">
          <Icon name="check" size={14} /> Mark Sent
        </button>
        <button className="cp-icon" title="Email the drawings to this company" onClick={onEmail}>
          <Icon name="send" size={14} />
        </button>
      </div>
    )
  }
  return (
    <div className="cp-cell">
      <button
        className="cp-chip cp-sent"
        title="Drawings sent - click to change"
        onClick={(e) => {
          setAt(toLocalInput(b.drawingsSentAt))
          setPop((e.currentTarget as HTMLElement).getBoundingClientRect())
        }}
      >
        <Icon name="check" size={14} /> {fmtDateTime(b.drawingsSentAt)}
      </button>
      {pop && (
        <Popover anchor={pop} onClose={() => setPop(null)} width={270}>
          <div className="pop-title">Drawings sent</div>
          <Field label="Date & time"><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          <div className="pop-actions">
            <Button small kind="danger" onClick={() => { act(b.id, 'clear_drawings_sent'); setPop(null) }}>Clear</Button>
            <span className="grow" />
            <Button small onClick={() => { setPop(null); onEmail() }} icon="send">Email again</Button>
            <Button small kind="primary" onClick={() => { bid.updateBidder(b.id, { drawingsSentAt: fromLocalInput(at) }); setPop(null) }}>Save</Button>
          </div>
        </Popover>
      )}
    </div>
  )
}

export function FollowUpCell({ b }: { b: Bidder }) {
  const act = useAct()
  const [pop, setPop] = useState<DOMRect | null>(null)
  const [note, setNote] = useState('')
  const [at, setAt] = useState('')
  const open = (e: React.MouseEvent) => {
    setNote('')
    setAt(toLocalInput(new Date().toISOString()))
    setPop((e.currentTarget as HTMLElement).getBoundingClientRect())
  }
  const log = (kind: 'follow_up_call' | 'follow_up_email') => {
    act(b.id, kind, { note, at: fromLocalInput(at) ?? undefined })
    setPop(null)
  }
  return (
    <div className="cp-cell">
      {b.followUpCount > 0 ? (
        <button className="cp-chip cp-follow" onClick={open} title="Follow-ups - click to log another">
          <Icon name="phone" size={14} /> {b.followUpCount}× · {fmtDateTime(b.lastFollowUpAt)}
        </button>
      ) : (
        <button className="cp-btn" onClick={open} title="Log a call or follow-up email">
          <Icon name="phone" size={14} /> Log Follow-Up
        </button>
      )}
      {pop && (
        <Popover anchor={pop} onClose={() => setPop(null)} width={300}>
          <div className="pop-title">Log follow-up with {b.companyName}</div>
          {b.phone && (
            <div className="pop-phone"><Icon name="phone" size={14} /> {b.phone}{b.contactName && <span className="muted"> ({b.contactName})</span>}</div>
          )}
          <Field label="Note (optional)">
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Left voicemail, will bid" onKeyDown={(e) => e.key === 'Enter' && log('follow_up_call')} />
          </Field>
          <Field label="Date & time"><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          <div className="pop-actions">
            {b.followUpCount > 0 && <Button small kind="danger" onClick={() => { act(b.id, 'clear_follow_up'); setPop(null) }}>Clear all</Button>}
            <span className="grow" />
            <Button small icon="mail" onClick={() => log('follow_up_email')}>Emailed</Button>
            <Button small kind="primary" icon="phone" onClick={() => log('follow_up_call')}>Called</Button>
          </div>
        </Popover>
      )}
    </div>
  )
}

export function PriceCell({ b }: { b: Bidder }) {
  const act = useAct()
  const [pop, setPop] = useState<DOMRect | null>(null)
  const [amount, setAmount] = useState('')
  const [at, setAt] = useState('')
  const [note, setNote] = useState('')
  const open = (e: React.MouseEvent) => {
    setAmount(b.priceAmount != null ? String(b.priceAmount) : '')
    setAt(toLocalInput(b.priceReceivedAt ?? new Date().toISOString()))
    setNote('')
    setPop((e.currentTarget as HTMLElement).getBoundingClientRect())
  }
  const save = () => {
    const value = parseMoney(amount)
    if (b.priceReceivedAt) bid.updateBidder(b.id, { priceAmount: value, priceReceivedAt: fromLocalInput(at) })
    else act(b.id, 'price_received', { amount: value, at: fromLocalInput(at) ?? undefined, note })
    setPop(null)
  }
  return (
    <div className="cp-cell">
      {b.priceReceivedAt ? (
        <button className="cp-chip cp-price" onClick={open} title={`Price received ${fmtDateTime(b.priceReceivedAt)}`}>
          <Icon name="dollar" size={14} /> {b.priceAmount != null ? fmtMoney(b.priceAmount) : 'Received'} · {fmtDateTime(b.priceReceivedAt)}
        </button>
      ) : (
        <button className="cp-btn" onClick={open}>
          <Icon name="dollar" size={14} /> Enter Price
        </button>
      )}
      {pop && (
        <Popover anchor={pop} onClose={() => setPop(null)} width={280}>
          <form onSubmit={(e) => { e.preventDefault(); save() }}>
            <div className="pop-title">Price from {b.companyName}</div>
            <Field label="Amount (leave blank if not known yet)">
              <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" />
            </Field>
            <Field label="Received"><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
            {!b.priceReceivedAt && <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Excludes permits" /></Field>}
            <div className="pop-actions">
              {b.priceReceivedAt && <Button small kind="danger" onClick={() => { act(b.id, 'clear_price'); setPop(null) }}>Clear</Button>}
              <span className="grow" />
              <Button small onClick={() => setPop(null)}>Cancel</Button>
              <Button small kind="success" type="submit">Save</Button>
            </div>
          </form>
        </Popover>
      )}
    </div>
  )
}