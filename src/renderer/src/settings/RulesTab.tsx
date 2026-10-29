// Mail rules editor: e.g. file plan-room notices into a folder, flag everything from a GC.
import { useEffect, useState } from 'react'
import { MailRule, RULE_FIELD_LABELS, RULE_OP_LABELS, RuleCondition, RuleField, RuleOp } from '../../../shared/rules'
import { rules as rulesApi } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Modal } from '../components/ui'
import { cx, randomId } from '../util'

let pendingDraft: Partial<MailRule> | null = null
/** Lets other screens open the rule editor pre-filled (e.g. "Create a rule for mail from this sender"). */
export function setRuleDraft(d: Partial<MailRule>) {
  pendingDraft = d
}

const blank = (accountId: string): MailRule => ({
  id: randomId(), name: '', enabled: true, accountId, match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: '' }], actions: { markRead: false, flag: false, silent: false }
})

export function RulesTab() {
  const { accounts, toast, confirm } = useApp()
  const [list, setList] = useState<MailRule[]>([])
  const [editing, setEditing] = useState<MailRule | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    rulesApi.list().then(setList)
    if (pendingDraft) {
      setEditing({ ...blank(accounts[0]?.id ?? '*'), ...pendingDraft } as MailRule)
      pendingDraft = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (next: MailRule[]) => setList(await rulesApi.save(next))
  const describe = (r: MailRule) => {
    const conds = r.conditions.filter((c) => c.value.trim()).map((c) => `${RULE_FIELD_LABELS[c.field]} ${RULE_OP_LABELS[c.op]} "${c.value}"`)
    const acts = [r.actions.moveTo && `move to ${r.actions.moveTo}`, r.actions.markRead && 'mark read', r.actions.flag && 'flag', r.actions.silent && 'no notification'].filter(Boolean)
    return `If ${conds.join(r.match === 'all' ? ' and ' : ' or ') || '(no conditions)'}: ${acts.join(', ') || '(no actions)'}`
  }

  return (
    <div className="card form-card">
      <p className="muted">Rules run on new mail as it arrives in the Inbox. Example: move plan-room notices to their own folder, or flag everything from a GC you're bidding to.</p>
      {list.length === 0 && <div className="muted">No rules yet.</div>}
      {list.map((r) => (
        <div key={r.id} className={cx('rule-row', !r.enabled && 'off')}>
          <label className="check" title={r.enabled ? 'On' : 'Off'}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => save(list.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} />
          </label>
          <div className="grow">
            <b>{r.name || 'Untitled rule'}</b>
            <span className="muted small"> · {r.accountId === '*' ? 'all accounts' : accounts.find((a) => a.id === r.accountId)?.email ?? 'removed account'}</span>
            <div className="muted small">{describe(r)}</div>
          </div>
          <Button small icon="edit" onClick={() => setEditing(r)}>Edit</Button>
          <Button small kind="ghost" icon="trash" onClick={async () => { if (await confirm({ title: 'Delete rule?', message: `Delete "${r.name}"?` })) save(list.filter((x) => x.id !== r.id)) }} />
        </div>
      ))}
      <div className="form-actions">
        <Button
          icon="refresh"
          disabled={!list.some((r) => r.enabled) || running}
          onClick={async () => {
            setRunning(true)
            try {
              const n = await rulesApi.run()
              toast(n ? `Rules applied to ${n} message(s) in your Inbox` : 'No Inbox messages matched your rules', 'success')
            } catch (e: any) {
              toast(e.message, 'error')
            } finally {
              setRunning(false)
            }
          }}
        >
          {running ? 'Running...' : 'Run rules on Inbox now'}
        </Button>
        <Button kind="primary" icon="plus" onClick={() => setEditing(blank(accounts[0]?.id ?? '*'))}>New Rule</Button>
      </div>
      {editing && (
        <RuleEditor
          rule={editing}
          onClose={() => setEditing(null)}
          onSave={(r) => {
            save(list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r])
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function RuleEditor({ rule, onClose, onSave }: { rule: MailRule; onClose: () => void; onSave: (r: MailRule) => void }) {
  const { accounts, folders, toast } = useApp()
  const [r, setR] = useState<MailRule>(rule)
  const acctFolders = r.accountId === '*' ? [] : folders[r.accountId] ?? []
  const setCond = (i: number, p: Partial<RuleCondition>) => setR({ ...r, conditions: r.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) })
  const save = () => {
    if (!r.conditions.some((c) => c.value.trim())) return toast('Add at least one condition with a value.', 'error')
    onSave({ ...r, name: r.name.trim() || 'Untitled rule', conditions: r.conditions.filter((c) => c.value.trim()) })
  }
  return (
    <Modal title={rule.name ? `Edit rule` : 'New rule'} onClose={onClose} width={720} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save rule</Button></>}>
      <div className="form-grid">
        <Field label="Rule name"><input autoFocus value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="e.g. Plan room notices" /></Field>
        <Field label="For mail in">
          <select value={r.accountId} onChange={(e) => setR({ ...r, accountId: e.target.value, actions: { ...r.actions, moveTo: e.target.value === '*' ? undefined : r.actions.moveTo } })}>
            <option value="*">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
          </select>
        </Field>
      </div>
      <div className="rule-conds">
        <div className="field-label">
          When{' '}
          <select value={r.match} onChange={(e) => setR({ ...r, match: e.target.value as 'all' | 'any' })}>
            <option value="all">all</option>
            <option value="any">any</option>
          </select>{' '}
          of these are true:
        </div>
        {r.conditions.map((c, i) => (
          <div key={i} className="cond-row">
            <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value as RuleField })}>
              {Object.entries(RULE_FIELD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value as RuleOp })}>
              {Object.entries(RULE_OP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="grow" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="text, email or @domain.com" />
            <Button small kind="ghost" icon="x" title="Remove" onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <Button small icon="plus" onClick={() => setR({ ...r, conditions: [...r.conditions, { field: 'subject', op: 'contains', value: '' }] })}>Add condition</Button>
      </div>
      <div className="field-label" style={{ marginTop: 14 }}>Then:</div>
      <div className="rule-actions">
        <label className="check">
          <input type="checkbox" checked={!!r.actions.moveTo} disabled={r.accountId === '*'} onChange={(e) => setR({ ...r, actions: { ...r.actions, moveTo: e.target.checked ? acctFolders.find((f) => !f.specialUse)?.path ?? acctFolders[0]?.path : undefined } })} />
          Move to folder
        </label>
        {r.actions.moveTo !== undefined && (
          <select value={r.actions.moveTo} onChange={(e) => setR({ ...r, actions: { ...r.actions, moveTo: e.target.value } })}>
            {acctFolders.filter((f) => f.specialUse !== '\\Inbox').map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
          </select>
        )}
        {r.accountId === '*' && <span className="muted small">(choose one account to move mail to a folder)</span>}
        <label className="check"><input type="checkbox" checked={!!r.actions.markRead} onChange={(e) => setR({ ...r, actions: { ...r.actions, markRead: e.target.checked } })} /> Mark as read</label>
        <label className="check"><input type="checkbox" checked={!!r.actions.flag} onChange={(e) => setR({ ...r, actions: { ...r.actions, flag: e.target.checked } })} /> <Icon name="star" size={14} /> Flag</label>
        <label className="check"><input type="checkbox" checked={!!r.actions.silent} onChange={(e) => setR({ ...r, actions: { ...r.actions, silent: e.target.checked } })} /> Don't show a notification</label>
      </div>
    </Modal>
  )
}