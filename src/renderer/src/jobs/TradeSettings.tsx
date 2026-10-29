import { useState } from 'react'
import type { Trade } from '../../../shared/types'
import { bid } from '../api'
import { useApp } from '../state'
import { Button, Field, Modal } from '../components/ui'

/** Per-trade drawings/spec links (for trades with their own package), template scope note and leveling checklist. */
export function TradeSettings({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const { toast } = useApp()
  const [f, setF] = useState({
    name: trade.name, csiCode: trade.csiCode, drawingsLink: trade.drawingsLink, specsLink: trade.specsLink,
    scopeNote: trade.scopeNote, scopeItems: trade.scopeItems.join('\n')
  })
  const save = async () => {
    try {
      await bid.updateTrade(trade.id, { ...f, scopeItems: f.scopeItems.split('\n').map((s) => s.trim()).filter(Boolean) })
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <Modal title={`${trade.name}: links & scope`} onClose={onClose} width={680} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Trade name"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="CSI code"><input value={f.csiCode} onChange={set('csiCode')} /></Field>
        <Field label="Drawings link for this trade (optional)" wide hint="Leave blank to use the job's link. Used for {{drawings_link}} in this trade's emails.">
          <input value={f.drawingsLink} onChange={set('drawingsLink')} placeholder="https://" />
        </Field>
        <Field label="Spec link for this trade (optional)" wide><input value={f.specsLink} onChange={set('specsLink')} placeholder="https://" /></Field>
        <Field label="Scope note for emails" wide hint="Inserted where a template has {{trade_scope}}, e.g. 'Include site lighting and EV chargers. Excludes fire alarm (by others).'">
          <textarea rows={3} value={f.scopeNote} onChange={set('scopeNote')} />
        </Field>
        <Field label="Scope checklist for bid leveling (one item per line)" wide hint="Each sub's quote is checked against these items on the Leveling tab.">
          <textarea rows={6} value={f.scopeItems} onChange={set('scopeItems')} placeholder={'Fire alarm\nTemp power\nSite lighting\nPermits & fees'} />
        </Field>
      </div>
    </Modal>
  )
}