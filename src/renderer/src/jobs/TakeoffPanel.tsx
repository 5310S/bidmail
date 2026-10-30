// The job's takeoff: who's doing it, status, due date. Shown in the job header.
import { Job, TakeoffStatus, TAKEOFF_STATUS_LABELS } from '../../../shared/types'
import { bid } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { cx, fmtDateTime, fromLocalInput, toLocalInput } from '../util'
import { PersonInput, usePeople } from './workflow'

export function TakeoffPanel({ job, extraNames }: { job: Job; extraNames: string[] }) {
  const { toast } = useApp()
  const t = job.takeoff
  const people = usePeople(extraNames)
  const set = (p: Parameters<typeof bid.setTakeoff>[1]) => bid.setTakeoff(job.id, p).catch((e) => toast(e.message, 'error'))
  const overdue = t.dueAt && new Date(t.dueAt).getTime() < Date.now() && t.status !== 'done' && t.status !== 'checked'
  return (
    <div className={cx('fact takeoff', `tk-${t.status}`, overdue && 'overdue')}>
      <Icon name="edit" />
      <div className="tk-fields">
        <div className="fact-label">Takeoff</div>
        <div className="tk-row">
          <PersonInput value={t.assignee} onChange={(v) => set({ assignee: v })} names={people} placeholder="Who's doing it?" />
          <select value={t.status} onChange={(e) => set({ status: e.target.value as TakeoffStatus })}>
            {Object.entries(TAKEOFF_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="datetime-local" title="Takeoff due" value={toLocalInput(t.dueAt)} onChange={(e) => set({ dueAt: fromLocalInput(e.target.value) })} />
        </div>
        <div className="muted small">
          {overdue ? <span className="err">Overdue · </span> : null}
          {t.updatedBy ? `Updated by ${t.updatedBy}, ${fmtDateTime(t.updatedAt)}` : 'Not assigned yet'}
        </div>
      </div>
    </div>
  )
}