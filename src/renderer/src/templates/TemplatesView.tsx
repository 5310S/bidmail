import { useEffect, useRef, useState } from 'react'
import { MERGE_FIELDS, Template } from '../../../shared/types'
import { bid } from '../api'
import { useApp, useBidQuery } from '../state'
import { Button, Empty, Field, Menu } from '../components/ui'
import { cx } from '../util'
import { RichEditor, RichEditorHandle } from '../mail/RichEditor'

const KIND_LABELS: Record<Template['kind'], string> = { invite: 'Bid invitation', followup: 'Follow-up', addendum: 'Addendum notice', other: 'Other' }

export function TemplatesView() {
  const { toast, confirm } = useApp()
  const { data: templates } = useBidQuery(() => bid.listTemplates(), [])
  const [selId, setSelId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<Template> | null>(null)
  const editor = useRef<RichEditorHandle>(null)

  useEffect(() => {
    if (!draft && templates?.length) {
      setSelId(templates[0].id)
      setDraft(templates[0])
    }
  }, [templates, draft])

  const pick = (t: Template) => {
    setSelId(t.id)
    setDraft(t)
  }

  const save = async () => {
    if (!draft) return
    try {
      const t = await bid.saveTemplate({ ...draft, body: editor.current?.getHtml() ?? draft.body })
      setSelId(t.id)
      setDraft(t)
      toast('Template saved', 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="page templates-page">
      <div className="page-head">
        <div>
          <h1>Email Templates</h1>
          <div className="muted">Used for bid invitations and follow-ups. Merge fields are filled in for each company.</div>
        </div>
        <span className="grow" />
        <Button kind="primary" icon="plus" onClick={() => { setSelId(null); setDraft({ name: 'New template', kind: 'other', subject: '', body: '<p>Hi {{first_name|there}},</p><p></p>' }) }}>New Template</Button>
      </div>
      <div className="tpl-grid">
        <div className="tpl-list">
          {(templates ?? []).map((t) => (
            <button key={t.id} className={cx('tpl-item', selId === t.id && 'on')} onClick={() => pick(t)}>
              <b>{t.name}</b>
              <span className="muted small">{KIND_LABELS[t.kind]}</span>
            </button>
          ))}
        </div>
        {draft ? (
          <div className="tpl-editor" key={selId ?? 'new'}>
            <div className="form-grid">
              <Field label="Name"><input value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
              <Field label="Used for">
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Template['kind'] })}>
                  {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Subject" wide><input value={draft.subject ?? ''} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></Field>
            </div>
            <div className="tpl-fields">
              <span className="field-label">Body</span>
              <span className="grow" />
              <Menu
                align="right"
                trigger={(open) => <Button small icon="plus" onClick={open}>Insert field</Button>}
                items={MERGE_FIELDS.map((m) => ({ label: `${m.label}  {{${m.key}}}`, onClick: () => editor.current?.insertHtml(`{{${m.key}}}`) }))}
              />
            </div>
            <RichEditor ref={editor} initialHtml={draft.body ?? ''} minHeight={320} />
            <div className="muted small">
              Tip: <code>{'{{first_name|there}}'}</code> uses "there" when a company has no contact name. Your signature is added automatically when sending.
            </div>
            <div className="tpl-actions">
              {draft.id && (
                <Button
                  kind="danger"
                  icon="trash"
                  onClick={async () => {
                    if (await confirm({ title: 'Delete template?', message: `Delete "${draft.name}"?` })) {
                      await bid.deleteTemplate(draft.id!)
                      setDraft(null)
                    }
                  }}
                >
                  Delete
                </Button>
              )}
              <span className="grow" />
              <Button kind="primary" onClick={save}>Save Template</Button>
            </div>
          </div>
        ) : (
          <Empty icon="template" title="No template selected" />
        )}
      </div>
    </div>
  )
}