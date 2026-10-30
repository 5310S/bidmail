// The team's bidding process: steps for each company and standard job milestones. Anyone can change it;
// every step and milestone shows who last changed it.
import { useEffect, useState } from 'react'
import { MilestoneTemplate, WorkflowConfig, WorkflowStep } from '../../../shared/types'
import { bid } from '../api'
import { useApp, useBidQuery } from '../state'
import { Icon } from '../components/Icon'
import { Button } from '../components/ui'
import { cx, fmtDateTime, randomId } from '../util'
import { STEP_COLORS } from '../jobs/workflow'

const BUILTIN_HELP: Record<string, string> = {
  drawings_sent: 'Ticks itself when drawings are emailed (Send Drawings) or "Mark Sent".',
  follow_up: 'Ticks itself when a call or follow-up email is logged.',
  will_bid: 'Ticks itself when the company is marked "Will Bid" (or sends a price).',
  price_received: 'Ticks itself when a price is entered.',
  filed: 'Ticks itself when a quote file is saved to the company, or tick it by hand.',
  custom: 'A checkmark anyone can tick, with their name and the time.'
}

export function WorkflowTab() {
  const { toast } = useApp()
  const { data } = useBidQuery(() => bid.getWorkflow(), [])
  const [wf, setWf] = useState<WorkflowConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  const [newStep, setNewStep] = useState('')
  const [newMs, setNewMs] = useState('')
  useEffect(() => {
    if (data && !dirty) setWf(data)
  }, [data, dirty])
  if (!wf) return null

  const edit = (p: Partial<WorkflowConfig>) => {
    setWf({ ...wf, ...p })
    setDirty(true)
  }
  const setStep = (i: number, p: Partial<WorkflowStep>) => edit({ steps: wf.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) })
  const move = (i: number, d: number) => {
    const s = [...wf.steps]
    const [x] = s.splice(i, 1)
    s.splice(Math.max(0, Math.min(s.length, i + d)), 0, x)
    edit({ steps: s })
  }
  const setMs = (i: number, p: Partial<MilestoneTemplate>) => edit({ milestones: wf.milestones.map((m, j) => (j === i ? { ...m, ...p } : m)) })
  const save = async () => {
    try {
      setWf(await bid.saveWorkflow(wf))
      setDirty(false)
      toast('Workflow saved for the whole team', 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  const changed = (by: string, at: string) => (by ? <span className="muted small">changed by {by}, {fmtDateTime(at)}</span> : <span className="muted small">standard</span>)

  return (
    <div className="settings-stack">
      <div className="card form-card">
        <h3>Steps for each company</h3>
        <p className="muted">These are the columns on each job's <b>Board</b> and the checklist on every company. Anyone on the team can change them; the change shows their name.</p>
        <div className="wf-list">
          {wf.steps.map((s, i) => (
            <div key={s.id} className={cx('wf-row', !s.enabled && 'off')}>
              <span className="wf-color" style={{ background: STEP_COLORS[s.kind] }} />
              <div className="wf-order">
                <button disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><Icon name="chevronDown" size={13} className="flip" /></button>
                <button disabled={i === wf.steps.length - 1} onClick={() => move(i, 1)} title="Move down"><Icon name="chevronDown" size={13} /></button>
              </div>
              <div className="grow">
                <input value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} />
                <div className="muted small">{BUILTIN_HELP[s.kind]} {changed(s.changedBy, s.changedAt)}</div>
              </div>
              <label className="check" title={s.enabled ? 'On' : 'Off'}><input type="checkbox" checked={s.enabled} onChange={(e) => setStep(i, { enabled: e.target.checked })} /> On</label>
              {s.kind === 'custom' ? (
                <Button small kind="ghost" icon="trash" title="Remove step" onClick={() => edit({ steps: wf.steps.filter((_, j) => j !== i) })} />
              ) : (
                <span className="wf-builtin" title="Built-in steps can be renamed or turned off">built-in</span>
              )}
            </div>
          ))}
        </div>
        <form className="add-scope" onSubmit={(e) => {
          e.preventDefault()
          if (!newStep.trim()) return
          edit({ steps: [...wf.steps, { id: randomId(), name: newStep.trim(), kind: 'custom', enabled: true, changedBy: '', changedAt: '' }] })
          setNewStep('')
        }}>
          <input value={newStep} onChange={(e) => setNewStep(e.target.value)} placeholder='Add a step, e.g. "Scope review call" or "Entered in bid sheet"' />
          <Button type="submit" icon="plus" disabled={!newStep.trim()}>Add step</Button>
        </form>
      </div>

      <div className="card form-card">
        <h3>Standard milestones for new jobs</h3>
        <p className="muted">Each new job starts with these on its <b>Timeline</b>, dated back from the bid due date. Change dates per job on the Timeline.</p>
        <div className="wf-list">
          {wf.milestones.map((m, i) => (
            <div key={m.id} className="wf-row">
              <span className="wf-color ms" />
              <div className="grow">
                <input value={m.name} onChange={(e) => setMs(i, { name: e.target.value })} />
                <div className="muted small">{changed(m.changedBy, m.changedAt)}</div>
              </div>
              <label className="wf-days">
                <input
                  type="number"
                  min={0}
                  value={m.daysBeforeBidDue ?? ''}
                  placeholder="-"
                  onChange={(e) => setMs(i, { daysBeforeBidDue: e.target.value === '' ? null : Number(e.target.value) })}
                />
                days before bid due
              </label>
              <Button small kind="ghost" icon="trash" title="Remove" onClick={() => edit({ milestones: wf.milestones.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </div>
        <form className="add-scope" onSubmit={(e) => {
          e.preventDefault()
          if (!newMs.trim()) return
          edit({ milestones: [...wf.milestones, { id: randomId(), name: newMs.trim(), daysBeforeBidDue: null, changedBy: '', changedAt: '' }] })
          setNewMs('')
        }}>
          <input value={newMs} onChange={(e) => setNewMs(e.target.value)} placeholder='Add a milestone, e.g. "Job walk" or "Bonding letter requested"' />
          <Button type="submit" icon="plus" disabled={!newMs.trim()}>Add milestone</Button>
        </form>
      </div>

      <div className="form-actions sticky-save">
        <span className="muted small grow">{wf.updatedBy ? `Last changed by ${wf.updatedBy}, ${fmtDateTime(wf.updatedAt)}` : 'Using the standard workflow'}</span>
        {dirty && <Button onClick={() => { setWf(data ?? wf); setDirty(false) }}>Undo changes</Button>}
        <Button kind="primary" disabled={!dirty} onClick={save}>Save for the team</Button>
      </div>
    </div>
  )
}