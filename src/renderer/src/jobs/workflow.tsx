// Shared pieces of the bidding workflow: the team's steps, ticking/unticking a step on a company
// (built-in steps run the real action, e.g. "Called" logs a call), and the checklist used on the
// board, the timeline and the company details.
import { useMemo, useState } from 'react'
import { Bidder, FileMeta, stepState, WorkflowStep } from '../../../shared/types'
import { bid, files as filesApi } from '../api'
import { useApp, useBidQuery } from '../state'
import { Icon } from '../components/Icon'
import { Button } from '../components/ui'
import { cx, fmtDateTime, parseMoney } from '../util'

export function useWorkflow() {
  const q = useBidQuery(() => bid.getWorkflow(), [])
  const steps = useMemo(() => (q.data?.steps ?? []).filter((s) => s.enabled), [q.data])
  return { workflow: q.data, steps }
}

/** The name used for "who did it": the signed-in team user, or your profile name. */
export function useMe() {
  const { team, settings } = useApp()
  return team?.mode === 'remote' && team.user ? team.user.displayName : settings.userName
}

export const STEP_COLORS: Record<string, string> = {
  drawings_sent: '#2f6fdb', follow_up: '#d98a1f', will_bid: '#1f8ea3', price_received: '#1d7f4c', filed: '#8a4fd1', custom: '#5a6b84'
}

/** Ticks a step. Built-ins perform the real action so everything else (Today, Bid Board...) stays in step. */
export async function completeStep(b: Bidder, step: WorkflowStep, amount?: number | null) {
  switch (step.kind) {
    case 'drawings_sent': return bid.bidderAction(b.id, 'drawings_sent')
    case 'follow_up': return bid.bidderAction(b.id, 'follow_up_call')
    case 'will_bid': return bid.bidderAction(b.id, 'will_bid')
    case 'price_received': return bid.bidderAction(b.id, 'price_received', { amount: amount ?? null })
    default: return bid.setBidderStep(b.id, step.id, true)
  }
}

export async function uncompleteStep(b: Bidder, step: WorkflowStep) {
  switch (step.kind) {
    case 'drawings_sent': return bid.bidderAction(b.id, 'clear_drawings_sent')
    case 'follow_up': return bid.bidderAction(b.id, 'clear_follow_up')
    case 'will_bid': return bid.bidderAction(b.id, 'clear_will_bid')
    case 'price_received': return bid.bidderAction(b.id, 'clear_price')
    default: return bid.setBidderStep(b.id, step.id, false)
  }
}

/** Every step for one company: done or not, who did it and when. Click to tick or untick. */
export function StepChecklist({ b, steps, files, jobId }: { b: Bidder; steps: WorkflowStep[]; files: FileMeta[]; jobId: string }) {
  const { toast, confirm } = useApp()
  const [pricing, setPricing] = useState<WorkflowStep | null>(null)
  const [amount, setAmount] = useState('')
  const run = (p: Promise<unknown>) => p.catch((e) => toast(e.message, 'error'))
  const fileBacked = files.some((f) => f.bidderId === b.id)

  const toggle = async (s: WorkflowStep) => {
    const st = stepState(b, s, files)
    if (!st.done) {
      if (s.kind === 'price_received') {
        setPricing(s)
        setAmount('')
        return
      }
      return run(completeStep(b, s))
    }
    if (s.kind === 'filed' && fileBacked && !b.steps.filed) return toast('This is ticked because a quote file is attached. Remove the file to untick it.', 'info')
    if (s.kind === 'follow_up') {
      const again = await confirm({ title: 'Follow-up', message: `Log another call to ${b.companyName}, or clear all follow-ups?`, confirmLabel: 'Log another call', danger: false })
      return run(again ? bid.bidderAction(b.id, 'follow_up_call') : uncompleteStep(b, s))
    }
    return run(uncompleteStep(b, s))
  }

  return (
    <div className="step-list">
      {steps.map((s) => {
        const st = stepState(b, s, files)
        return (
          <div key={s.id} className={cx('step-row', st.done && 'done')}>
            <button className="step-check" style={{ borderColor: STEP_COLORS[s.kind], background: st.done ? STEP_COLORS[s.kind] : undefined }} onClick={() => toggle(s)} title={st.done ? 'Click to change' : 'Mark done now'}>
              {st.done && <Icon name="check" size={13} />}
            </button>
            <span className="grow">{s.name}</span>
            {st.done ? <span className="muted small">{fmtDateTime(st.at)}{st.by ? ` · ${st.by}` : ''}</span> : <span className="muted small">-</span>}
          </div>
        )
      })}
      {b.declinedAt && <div className="step-row declined"><Icon name="ban" size={15} /> <span className="grow">Not bidding</span><span className="muted small">{fmtDateTime(b.declinedAt)}</span></div>}
      {pricing && (
        <form className="step-price" onSubmit={(e) => { e.preventDefault(); run(completeStep(b, pricing, amount.trim() ? parseMoney(amount) : null)); setPricing(null) }}>
          <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Price $ (optional)" />
          <Button small kind="success" type="submit">Price received</Button>
          <Button small onClick={() => setPricing(null)}>Cancel</Button>
        </form>
      )}
      <div className="step-actions">
        {b.declinedAt ? (
          <Button small onClick={() => run(bid.bidderAction(b.id, 'clear_declined'))}>Undo "Not bidding"</Button>
        ) : (
          <Button small icon="ban" onClick={() => run(bid.bidderAction(b.id, 'declined'))}>Not bidding</Button>
        )}
        <Button small icon="paperclip" onClick={() => run(filesApi.addFromDisk(jobId, b.id))}>Attach quote</Button>
      </div>
    </div>
  )
}

/** Free-text name with suggestions (teammates and names already used). */
export function PersonInput({ value, onChange, names, placeholder }: { value: string; onChange: (v: string) => void; names: string[]; placeholder?: string }) {
  const [id] = useState(() => 'people-' + Math.random().toString(36).slice(2))
  const [v, setV] = useState(value)
  return (
    <>
      <input
        list={id}
        value={v}
        placeholder={placeholder ?? 'Name'}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onChange(v.trim())}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <datalist id={id}>{[...new Set(names.filter(Boolean))].map((n) => <option key={n} value={n} />)}</datalist>
    </>
  )
}

/** Names to suggest when assigning work. */
export function usePeople(extra: string[] = []): string[] {
  const { jobs, team, settings } = useApp()
  return useMemo(() => {
    const s = new Set<string>([settings.userName, team?.user?.displayName ?? '', ...extra])
    for (const j of jobs) if (j.takeoff?.assignee) s.add(j.takeoff.assignee)
    return [...s].filter(Boolean).sort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, team, settings.userName, extra.join('|')])
}