// "Send Drawings": one personalized email per company, with the drawings & spec links merged in.
import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { BulkProgress, ComposeAttachment } from '../../../shared/ipc'
import { Bidder, bidderStage, BIDDER_STAGE_LABELS, fillTemplate, JobDetail, MERGE_FIELDS, Template } from '../../../shared/types'
import { mergeFields, signOff } from '../../../shared/merge'
import { bid, bulk, on, sys } from '../api'
import { useApp, useBidQuery } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Menu, Modal } from '../components/ui'
import { cx, fmtDateTime, fmtSize } from '../util'
import { RichEditor, RichEditorHandle } from '../mail/RichEditor'

type Mode = 'invite' | 'followup' | 'addendum'

const hasEmail = (b: Bidder) => b.email.split(/[;,\s]+/).some((e) => e.includes('@'))

export function BulkSend({ detail, mode, tradeId, addendumId, onClose }: { detail: JobDetail; mode: Mode; tradeId?: string; addendumId?: string; onClose: () => void }) {
  const addendum = mode === 'addendum' ? detail.addenda.find((a) => a.id === addendumId) ?? null : null
  const { accounts, settings, toast, go } = useApp()
  const { data: templates } = useBidQuery(() => bid.listTemplates(), [])
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [templateId, setTemplateId] = useState('')
  const [subject, setSubject] = useState('')
  const [cc, setCc] = useState('')
  const [markAs, setMarkAs] = useState<'drawings_sent' | 'follow_up_email' | 'addendum' | 'none'>(mode === 'invite' ? 'drawings_sent' : mode === 'addendum' ? 'addendum' : 'follow_up_email')
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([])
  const [previewId, setPreviewId] = useState<string>('')
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const [runId, setRunId] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, BulkProgress>>({})
  const [done, setDone] = useState(false)
  const [bodyHtml, setBodyHtml] = useState('')
  const editor = useRef<RichEditorHandle>(null)
  const [editorKey, setEditorKey] = useState(0)
  const [qtyAdded, setQtyAdded] = useState(false)

  const all = detail.trades.flatMap((t) => t.bidders.map((b) => ({ b, t })))
  const defaultSel = () => {
    const pool = tradeId ? all.filter((x) => x.t.id === tradeId) : all
    return new Set(
      pool
        .filter(({ b }) => hasEmail(b) && !b.declinedAt && (mode === 'invite' ? !b.drawingsSentAt : mode === 'addendum' ? !!b.drawingsSentAt && !b.addendaSent[addendumId ?? ''] : !b.priceReceivedAt))
        .map(({ b }) => b.id)
    )
  }
  const [sel, setSel] = useState<Set<string>>(defaultSel)

  // Pick the default template for this mode once templates load.
  useEffect(() => {
    if (!templates || templateId) return
    const t = templates.find((x) => x.kind === (mode === 'invite' ? 'invite' : mode === 'addendum' ? 'addendum' : 'followup')) ?? templates[0]
    if (t) applyTemplate(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates])

  useEffect(() => {
    if (!runId) return
    return on('bulk:progress', (p: BulkProgress) => {
      if (p.runId !== runId) return
      if (p.bidderId) setProgress((m) => ({ ...m, [p.bidderId]: p }))
      if (p.done) setDone(true)
    })
  }, [runId])

  // Jobs set up from a Leopard takeoff: requests for bids carry each trade's quantities.
  const jobHasQuantities = detail.trades.some((t) => t.takeoffLines?.length)
  const applyTemplate = (t: Template) => {
    setTemplateId(t.id)
    setSubject(t.subject)
    setBodyHtml(mode === 'invite' && jobHasQuantities ? withQuantities(t.body) : t.body)
    setEditorKey((k) => k + 1)
  }

  const me = { name: settings.userName, company: settings.companyName }
  const previewTarget = all.find((x) => x.b.id === previewId) ?? all.find((x) => sel.has(x.b.id)) ?? all[0]
  const currentBody = () => editor.current?.getHtml() ?? bodyHtml
  const preview = useMemo(() => {
    if (!previewTarget || tab !== 'preview') return null
    const f = mergeFields(detail.job, previewTarget.t, previewTarget.b, me, addendum)
    const sig = signOff(accounts.find((a) => a.id === accountId)?.signature ?? '', me)
    return { subject: fillTemplate(subject, f, false), html: fillTemplate(currentBody(), f, true) + (sig ? '<br>' + sig : '') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewTarget?.b.id, tab, subject, accountId])

  const warnings: string[] = []
  const bodyNow = bodyHtml + subject
  if (/drawings_link/.test(bodyNow) && !detail.job.drawingsLink) warnings.push('This job has no drawings link yet. Add it with Edit Job, or the link will be blank.')
  if (/specs_link/.test(bodyNow) && !detail.job.specsLink) warnings.push('This job has no spec book link yet.')
  if (/bid_due/.test(bodyNow) && !detail.job.bidDue) warnings.push('This job has no bid due date set.')
  if (/my_company/.test(bodyNow) && !settings.companyName) warnings.push('Your company name is not set (Settings > Profile).')
  if (/addendum_link/.test(bodyNow) && addendum && !addendum.link) warnings.push('This addendum has no link. Add one on the Addenda tab, or attach the addendum file below.')

  const toggleTrade = (tid: string, on: boolean) => {
    const n = new Set(sel)
    for (const { b, t } of all) if (t.id === tid && hasEmail(b)) on ? n.add(b.id) : n.delete(b.id)
    setSel(n)
  }
  const quick = (fn: (b: Bidder) => boolean) => setSel(new Set(all.filter(({ b }) => hasEmail(b) && fn(b)).map(({ b }) => b.id)))

  const start = async () => {
    if (!accountId) return toast('Add an email account first (Settings > Accounts).', 'error')
    if (!sel.size) return toast('Select at least one company.', 'error')
    const body = currentBody()
    setBodyHtml(body)
    try {
      const id = await bulk.start({ accountId, jobId: detail.job.id, bidderIds: [...sel], subject, body, cc, attachments, markAs, addendumId: addendum?.id })
      setProgress({})
      setDone(false)
      setRunId(id)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const insertField = (key: string) => editor.current?.insertHtml(`{{${key}}}`)
  // Trades set up from a Leopard takeoff carry their quantities; offer to put them in the request for bids.
  const selectedWithQty = detail.trades.filter((t) => t.takeoffLines?.length && t.bidders.some((b) => sel.has(b.id))).length
  const hasQtyField = qtyAdded || /takeoff_quantities/.test(bodyHtml)
  const addQuantities = () => {
    setBodyHtml(withQuantities(currentBody()))
    setEditorKey((k) => k + 1)
    setQtyAdded(true)
  }
  // ---------- progress screen ----------
  if (runId) {
    const items = [...sel].map((id) => ({ ...all.find((x) => x.b.id === id)!, p: progress[id] }))
    const sent = items.filter((i) => i.p?.state === 'sent').length
    const failed = items.filter((i) => i.p?.state === 'failed' || i.p?.state === 'skipped')
    return (
      <Modal
        title={done ? 'Finished sending' : 'Sending...'}
        onClose={() => (done ? onClose() : undefined)}
        width={640}
        footer={
          done ? (
            <>
              {failed.length > 0 && (
                <Button onClick={() => { setSel(new Set(failed.map((f) => f.b.id))); setRunId(null) }}>Retry failed ({failed.length})</Button>
              )}
              <Button kind="primary" onClick={onClose}>Done</Button>
            </>
          ) : (
            <Button kind="danger" onClick={() => bulk.cancel(runId)}>Stop sending</Button>
          )
        }
      >
        <div className="bulk-summary">
          <b>{sent}</b> of {items.length} sent{failed.length ? <> · <span className="err">{failed.length} failed</span></> : null}
        </div>
        <div className="progress big"><div style={{ width: `${(Object.values(progress).filter((p) => p.state !== 'queued' && p.state !== 'sending').length / Math.max(1, items.length)) * 100}%` }} /></div>
        <ul className="bulk-list">
          {items.map(({ b, t, p }) => (
            <li key={b.id} className={cx('bulk-item', p?.state)}>
              <span className="bulk-state">
                {p?.state === 'sent' ? <Icon name="check" /> : p?.state === 'failed' || p?.state === 'skipped' ? <Icon name="alert" /> : p?.state === 'sending' ? <span className="spinner sm" /> : <Icon name="clock" />}
              </span>
              <span className="grow">
                <b>{b.companyName}</b> <span className="muted">· {t.name} · {b.email}</span>
                {p?.error && <div className="err small">{p.error}</div>}
              </span>
              <span className="muted small">{p?.state ?? 'queued'}</span>
            </li>
          ))}
        </ul>
        {done && markAs !== 'none' && sent > 0 && (
          <p className="muted">Each company that was emailed is now marked "{markAs === 'drawings_sent' ? 'Drawings Sent' : markAs === 'addendum' ? `Addendum ${addendum?.number} sent` : 'Followed Up'}" with today's date and time.</p>
        )}
      </Modal>
    )
  }

  // ---------- setup screen ----------
  return (
    <Modal title={mode === 'invite' ? `Send drawings · ${detail.job.name}` : mode === 'addendum' ? `Send Addendum ${addendum?.number ?? ''} · ${detail.job.name}` : `Follow up · ${detail.job.name}`} onClose={onClose} width={1180} className="bulk-modal"
      footer={
        <>
          <span className="muted grow">
            {sel.size} compan{sel.size === 1 ? 'y' : 'ies'} selected. Each gets its own email; replies come back to you individually.
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" icon="send" onClick={start} disabled={!sel.size || !accounts.length}>
            Send {sel.size} email{sel.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {!accounts.length && (
        <div className="warn-box">
          <Icon name="alert" /> No email account yet. <button className="link-btn" onClick={() => { onClose(); go({ kind: 'settings', tab: 'accounts' }) }}>Add one in Settings</button>
        </div>
      )}
      <div className="bulk-grid">
        <div className="bulk-recipients">
          <div className="bulk-quick">
            <span className="field-label">Select:</span>
            {mode === 'addendum' && <button className="chip" onClick={() => quick((b) => !!b.drawingsSentAt && !b.declinedAt && !b.addendaSent[addendumId ?? ''])}>Haven't received it</button>}
            {mode === 'addendum' && <button className="chip" onClick={() => quick((b) => !!b.drawingsSentAt && !b.declinedAt)}>Everyone invited</button>}
            {mode !== 'addendum' && <button className="chip" onClick={() => quick((b) => !b.drawingsSentAt && !b.declinedAt)}>Not sent yet</button>}
            <button className="chip" onClick={() => quick((b) => !!b.drawingsSentAt && !b.priceReceivedAt && !b.declinedAt)}>Sent, no price</button>
            <button className="chip" onClick={() => quick((b) => !b.declinedAt)}>Everyone</button>
            <button className="chip" onClick={() => setSel(new Set())}>None</button>
          </div>
          <div className="bulk-tree">
            {detail.trades.map((t) => {
              const withEmail = t.bidders.filter(hasEmail)
              const allOn = withEmail.length > 0 && withEmail.every((b) => sel.has(b.id))
              return (
                <div key={t.id} className="bt-trade">
                  <label className="bt-trade-head">
                    <input type="checkbox" checked={allOn} disabled={!withEmail.length} onChange={(e) => toggleTrade(t.id, e.target.checked)} />
                    <b>{t.name}</b> <span className="muted">({t.bidders.filter((b) => sel.has(b.id)).length}/{t.bidders.length})</span>
                  </label>
                  {t.bidders.map((b) => {
                    const ok = hasEmail(b)
                    const st = bidderStage(b)
                    return (
                      <label key={b.id} className={cx('bt-row', !ok && 'disabled')} title={ok ? b.email : 'No email address for this company'}>
                        <input
                          type="checkbox"
                          disabled={!ok}
                          checked={sel.has(b.id)}
                          onChange={(e) => {
                            const n = new Set(sel)
                            if (e.target.checked) n.add(b.id)
                            else n.delete(b.id)
                            setSel(n)
                          }}
                        />
                        <span className="grow ellipsis">
                          {b.companyName}
                          <span className="muted small"> {ok ? b.email : 'no email'}</span>
                        </span>
                        <span className={cx('stage sm', `st-${st}`)} title={b.drawingsSentAt ? 'Sent ' + fmtDateTime(b.drawingsSentAt) : ''}>{BIDDER_STAGE_LABELS[st]}</span>
                      </label>
                    )
                  })}
                  {t.bidders.length === 0 && <div className="muted small bt-none">No companies</div>}
                </div>
              )
            })}
          </div>
        </div>

        <div className="bulk-message">
          <div className="form-grid">
            <Field label="Send from">
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
              </select>
            </Field>
            <Field label="Template">
              <select value={templateId} onChange={(e) => { const t = templates?.find((x) => x.id === e.target.value); if (t) applyTemplate(t) }}>
                {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Subject" wide><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
            <Field label="Cc on every email (optional)" wide><input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="e.g. your project manager" /></Field>
          </div>
          <div className="seg small">
            <button className={tab === 'write' ? 'on' : ''} onClick={() => setTab('write')}>Message</button>
            <button className={tab === 'preview' ? 'on' : ''} onClick={() => { setBodyHtml(currentBody()); setTab('preview') }}>Preview</button>
            <span className="grow" />
            {tab === 'write' && (
              <Menu
                align="right"
                trigger={(open) => <Button small icon="plus" onClick={open}>Insert field</Button>}
                items={MERGE_FIELDS.map((m) => ({ label: `${m.label}  {{${m.key}}}`, onClick: () => insertField(m.key) }))}
              />
            )}
            {tab === 'preview' && (
              <select value={previewTarget?.b.id ?? ''} onChange={(e) => setPreviewId(e.target.value)}>
                {all.filter(({ b }) => sel.has(b.id)).map(({ b, t }) => <option key={b.id} value={b.id}>{b.companyName} ({t.name})</option>)}
              </select>
            )}
          </div>
          <div style={{ display: tab === 'write' ? 'block' : 'none' }}>
            <RichEditor key={editorKey} ref={editor} initialHtml={bodyHtml} minHeight={230} onChange={() => {}} />
            <div className="muted small">
              Fields like <code>{'{{first_name}}'}</code> and <code>{'{{drawings_link}}'}</code> are filled in for each company. <code>{'{{first_name|there}}'}</code> uses "there" when no contact name is known.
            </div>
          </div>
          {tab === 'preview' && preview && (
            <div className="preview-card">
              <div className="preview-sub"><span className="muted">To:</span> {previewTarget?.b.email}</div>
              <div className="preview-sub"><span className="muted">Subject:</span> <b>{preview.subject}</b></div>
              <div className="preview-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(preview.html) }} />
            </div>
          )}
          <div className="bulk-opts">
            <Field label="After each email is sent, mark the company as">
              <select value={markAs} onChange={(e) => setMarkAs(e.target.value as any)}>
                {addendum && <option value="addendum">Addendum {addendum.number} sent (with date & time)</option>}
                <option value="drawings_sent">Drawings Sent (with date & time)</option>
                <option value="follow_up_email">Followed Up (with date & time)</option>
                <option value="none">Don't change status</option>
              </select>
            </Field>
            <div className="bulk-atts">
              <Button small icon="paperclip" onClick={async () => { const f = await sys.openFiles(); setAttachments((a) => [...a, ...f.map((x) => ({ filename: x.name, path: x.path, size: x.size }))]) }}>Attach files</Button>
              {attachments.map((a, i) => (
                <span key={i} className="att-pill">
                  <Icon name="paperclip" size={13} /> {a.filename} <span className="muted">({fmtSize(a.size ?? 0)})</span>
                  <button onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
                </span>
              ))}
              {attachments.length === 0 && <span className="muted small">Tip: send drawings as a link; large attachments often bounce.</span>}
            </div>
          </div>
          {mode === 'invite' && selectedWithQty > 0 && !hasQtyField && tab === 'write' && (
            <div className="ok-box">
              <Icon name="grid" size={16} />
              <span className="grow">{selectedWithQty} selected trade{selectedWithQty === 1 ? ' has' : 's have'} quantities from the Leopard takeoff.</span>
              <button className="link-btn" onClick={addQuantities}>Add takeoff quantities to the message</button>
            </div>
          )}
          {warnings.map((w) => (
            <div key={w} className="warn-box"><Icon name="alert" size={16} /> {w}</div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/** Adds the trade's takeoff quantities to a message: before the sign-off when there is one, else at the end. */
function withQuantities(html: string) {
  if (/takeoff_quantities/.test(html)) return html
  const closing = /(<p>\s*(Thanks|Thank you|Regards|Best|Sincerely)[\s\S]*)$/i
  return closing.test(html) ? html.replace(closing, '<p>{{takeoff_quantities}}</p>$1') : html + '<p>{{takeoff_quantities}}</p>'
}
