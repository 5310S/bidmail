// Addenda: record each addendum, send it to every invited company in one go, and track who received
// and acknowledged it (with dates).
import { useState } from 'react'
import type { Addendum, JobDetail } from '../../../shared/types'
import { bid, sys } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Field, Modal } from '../components/ui'
import { cx, fmtDate, fmtDateTime, fromLocalInput, toLocalInput } from '../util'

export function AddendaTab({ detail, onSend }: { detail: JobDetail; onSend: (addendumId: string) => void }) {
  const { toast, confirm } = useApp()
  const [editing, setEditing] = useState<Partial<Addendum> | null>(null)
  const [open, setOpen] = useState<string | null>(detail.addenda[detail.addenda.length - 1]?.id ?? null)
  const invited = detail.trades.flatMap((t) => t.bidders.map((b) => ({ b, t }))).filter(({ b }) => b.drawingsSentAt && !b.declinedAt)

  return (
    <div className="addenda">
      <div className="toolbar">
        <Button kind="primary" icon="plus" onClick={() => setEditing({ number: String(detail.addenda.length + 1), issuedAt: new Date().toISOString() })}>
          Add Addendum
        </Button>
        <span className="muted">Addenda go to every company that received the drawings and isn't marked "Not Bidding".</span>
      </div>
      {detail.addenda.length === 0 && (
        <Empty icon="file" title="No addenda yet">When an addendum is issued, add it here and send it to all {invited.length} invited compan{invited.length === 1 ? 'y' : 'ies'} at once.</Empty>
      )}
      {[...detail.addenda].reverse().map((a) => {
        const sent = invited.filter(({ b }) => b.addendaSent[a.id])
        const acked = invited.filter(({ b }) => b.addendaAck[a.id])
        const missing = invited.length - sent.length
        return (
          <section key={a.id} className="addendum-card">
            <header>
              <button className="trade-toggle" onClick={() => setOpen(open === a.id ? null : a.id)}>
                <Icon name={open === a.id ? 'chevronDown' : 'chevronRight'} />
              </button>
              <div className="grow">
                <h3>Addendum {a.number}{a.title ? `: ${a.title}` : ''}</h3>
                <div className="muted small">Issued {fmtDate(a.issuedAt)}{a.description ? ` · ${a.description.slice(0, 140)}` : ''}</div>
              </div>
              <div className="addendum-stats">
                <span className={missing ? 'err' : 'ok-text'}>{sent.length}/{invited.length} sent</span>
                <span className="muted">{acked.length} acknowledged</span>
              </div>
              {a.link && <Button small icon="external" onClick={() => sys.openExternal(a.link)}>Open</Button>}
              <Button small kind={missing ? 'primary' : 'default'} icon="send" onClick={() => onSend(a.id)} disabled={!invited.length}>
                {missing ? `Send to ${missing}` : 'Send again'}
              </Button>
              <Button small kind="ghost" icon="edit" title="Edit" onClick={() => setEditing(a)} />
              <Button
                small
                kind="ghost"
                icon="trash"
                title="Delete"
                onClick={async () => {
                  if (await confirm({ title: 'Delete addendum?', message: `Delete Addendum ${a.number} and its sent/acknowledged records?` })) bid.deleteAddendum(a.id)
                }}
              />
            </header>
            {open === a.id && (
              <table className="bidder-table">
                <thead><tr><th>Company</th><th>Trade</th><th>Sent</th><th>Acknowledged</th></tr></thead>
                <tbody>
                  {invited.map(({ b, t }) => (
                    <tr key={b.id} className={cx(!b.addendaSent[a.id] && 'row-missing')}>
                      <td><b>{b.companyName}</b><div className="muted small">{b.email}</div></td>
                      <td>{t.name}</td>
                      <td>
                        {b.addendaSent[a.id] ? (
                          <span className="cp-chip cp-sent"><Icon name="check" size={14} /> {fmtDateTime(b.addendaSent[a.id])}</span>
                        ) : (
                          <button className="cp-btn" onClick={() => bid.markAddendumSent(a.id, [b.id]).catch((e) => toast(e.message, 'error'))}>
                            <Icon name="check" size={14} /> Mark sent
                          </button>
                        )}
                      </td>
                      <td>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={!!b.addendaAck[a.id]}
                            onChange={(e) => bid.setAddendumAck(a.id, b.id, e.target.checked ? new Date().toISOString() : null).catch((er) => toast(er.message, 'error'))}
                          />
                          {b.addendaAck[a.id] ? fmtDateTime(b.addendaAck[a.id]) : <span className="muted">Not yet</span>}
                        </label>
                      </td>
                    </tr>
                  ))}
                  {!invited.length && <tr><td colSpan={4} className="muted">Nobody has been sent the drawings yet.</td></tr>}
                </tbody>
              </table>
            )}
          </section>
        )
      })}
      {editing && (
        <AddendumForm
          jobId={detail.job.id}
          addendum={editing}
          onClose={() => setEditing(null)}
          onCreated={async (a) => {
            setOpen(a.id)
            if (invited.length && (await confirm({ title: 'Send it now?', message: `Email Addendum ${a.number} to the ${invited.length} invited compan${invited.length === 1 ? 'y' : 'ies'}?`, confirmLabel: 'Send now', danger: false }))) onSend(a.id)
          }}
        />
      )}
    </div>
  )
}

function AddendumForm({ jobId, addendum, onClose, onCreated }: { jobId: string; addendum: Partial<Addendum>; onClose: () => void; onCreated: (a: Addendum) => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({
    number: addendum.number ?? '', title: addendum.title ?? '', issuedAt: toLocalInput(addendum.issuedAt), link: addendum.link ?? '', description: addendum.description ?? ''
  })
  const save = async () => {
    try {
      const data = { ...f, issuedAt: fromLocalInput(f.issuedAt) }
      if (addendum.id) await bid.updateAddendum(addendum.id, data)
      else onCreated(await bid.addAddendum(jobId, data))
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <Modal title={addendum.id ? `Edit Addendum ${addendum.number}` : 'Add Addendum'} onClose={onClose} width={600}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>{addendum.id ? 'Save' : 'Add Addendum'}</Button></>}>
      <div className="form-grid">
        <Field label="Addendum number"><input value={f.number} onChange={set('number')} /></Field>
        <Field label="Issued"><input type="datetime-local" value={f.issuedAt} onChange={set('issuedAt')} /></Field>
        <Field label="Title" wide><input autoFocus value={f.title} onChange={set('title')} placeholder="e.g. Revised electrical sheets, bid date extended" /></Field>
        <Field label="Link to the addendum" wide hint="Shared folder or plan room link. Used as {{addendum_link}} in the email."><input value={f.link} onChange={set('link')} placeholder="https://" /></Field>
        <Field label="What changed" wide><textarea rows={4} value={f.description} onChange={set('description')} placeholder="Sheets E-101 to E-104 revised; Q&A responses; new bid date..." /></Field>
      </div>
    </Modal>
  )
}