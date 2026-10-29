import { useState } from 'react'
import { Job, JobStatus, JOB_STATUS_LABELS, STANDARD_TRADES } from '../../../shared/types'
import { bid, sys } from '../api'
import { useApp } from '../state'
import { Button, Field, Modal } from '../components/ui'
import { fromLocalInput, isMac, toLocalInput } from '../util'

/** Create or edit a job. New jobs can start from the standard trade list or copy another job. */
export function JobForm({ job, onClose, onSaved }: { job?: Job; onClose: () => void; onSaved?: (j: Job) => void }) {
  const { jobs, toast } = useApp()
  const [f, setF] = useState({
    name: job?.name ?? '',
    number: job?.number ?? '',
    client: job?.client ?? '',
    location: job?.location ?? '',
    bidDue: toLocalInput(job?.bidDue),
    drawingsLink: job?.drawingsLink ?? '',
    specsLink: job?.specsLink ?? '',
    folderPath: job?.folderPath ?? '',
    notes: job?.notes ?? '',
    status: (job?.status ?? 'bidding') as JobStatus
  })
  const [start, setStart] = useState<'blank' | 'standard' | 'copy'>('standard')
  const [picked, setPicked] = useState<Set<string>>(new Set(['Cast-in-Place Concrete', 'Drywall & Framing', 'Painting', 'Plumbing', 'HVAC', 'Electrical']))
  const [copyFrom, setCopyFrom] = useState(jobs[0]?.id ?? '')
  const [copyCompanies, setCopyCompanies] = useState(true)
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }))

  const save = async () => {
    if (!f.name.trim()) return toast('Give the job a name.', 'error')
    setSaving(true)
    try {
      const data = { ...f, bidDue: fromLocalInput(f.bidDue) }
      let saved: Job
      if (job) saved = await bid.updateJob(job.id, data)
      else {
        saved = await bid.createJob(data)
        if (start === 'standard' && picked.size) {
          await bid.addTrades(saved.id, STANDARD_TRADES.filter((t) => picked.has(t.name)).map((t) => ({ name: t.name, csiCode: t.csi })))
        } else if (start === 'copy' && copyFrom) {
          await bid.copyTrades(saved.id, copyFrom, copyCompanies)
        }
      }
      toast(job ? 'Job updated' : 'Job created', 'success')
      onSaved?.(saved)
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={job ? 'Edit Job' : 'New Job'}
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={save} disabled={saving}>{job ? 'Save' : 'Create Job'}</Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Job name" wide><input autoFocus value={f.name} onChange={set('name')} placeholder="e.g. Riverside Medical Office Building" /></Field>
        <Field label="Job / bid number"><input value={f.number} onChange={set('number')} /></Field>
        <Field label="Client / GC / Owner"><input value={f.client} onChange={set('client')} /></Field>
        <Field label="Location"><input value={f.location} onChange={set('location')} placeholder="City, State" /></Field>
        <Field label="Bid due date & time"><input type="datetime-local" value={f.bidDue} onChange={set('bidDue')} /></Field>
        <Field label="Drawings link" wide hint="Link to the drawing set (Dropbox, Box, SharePoint, plan room, etc.)">
          <input value={f.drawingsLink} onChange={set('drawingsLink')} placeholder="https://" />
        </Field>
        <Field label="Spec book link" wide><input value={f.specsLink} onChange={set('specsLink')} placeholder="https://" /></Field>
        <Field label="Job folder on this computer (optional)" wide hint="Lets you save sub quotes from emails straight into the job folder.">
          <div className="input-with-btn">
            <input value={f.folderPath} onChange={set('folderPath')} placeholder={isMac ? '/Users/you/Bids/Riverside MOB' : 'C:\\Bids\\Riverside MOB'} />
            <Button onClick={async () => { const p = await sys.pickFolder(f.folderPath || undefined); if (p) setF((x) => ({ ...x, folderPath: p })) }}>Browse...</Button>
          </div>
        </Field>
        {job && (
          <Field label="Status">
            <select value={f.status} onChange={set('status')}>
              {Object.entries(JOB_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        )}
        <Field label="Notes" wide><textarea rows={3} value={f.notes} onChange={set('notes')} /></Field>
      </div>

      {!job && (
        <div className="trade-start">
          <div className="field-label">Trades</div>
          <div className="seg">
            <button className={start === 'standard' ? 'on' : ''} onClick={() => setStart('standard')}>Pick from standard trades</button>
            <button className={start === 'copy' ? 'on' : ''} onClick={() => setStart('copy')} disabled={!jobs.length}>Copy from another job</button>
            <button className={start === 'blank' ? 'on' : ''} onClick={() => setStart('blank')}>Start empty</button>
          </div>
          {start === 'standard' && (
            <>
              <div className="trade-pick">
                {STANDARD_TRADES.map((t) => (
                  <label key={t.name} className={picked.has(t.name) ? 'on' : ''}>
                    <input
                      type="checkbox"
                      checked={picked.has(t.name)}
                      onChange={(e) => {
                        const n = new Set(picked)
                        if (e.target.checked) n.add(t.name)
                        else n.delete(t.name)
                        setPicked(n)
                      }}
                    />
                    <span className="muted mono">{t.csi.slice(0, 2)}</span> {t.name}
                  </label>
                ))}
              </div>
              <div className="trade-pick-actions">
                <button className="link-btn" onClick={() => setPicked(new Set(STANDARD_TRADES.map((t) => t.name)))}>Select all</button>
                <button className="link-btn" onClick={() => setPicked(new Set())}>Clear</button>
                <span className="muted">{picked.size} selected. You can add custom trades later.</span>
              </div>
            </>
          )}
          {start === 'copy' && (
            <div className="form-grid">
              <Field label="Copy trades from">
                <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}{j.number ? ` (${j.number})` : ''}</option>)}
                </select>
              </Field>
              <label className="check">
                <input type="checkbox" checked={copyCompanies} onChange={(e) => setCopyCompanies(e.target.checked)} />
                Also copy the companies under each trade (statuses start fresh)
              </label>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}