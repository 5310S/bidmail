import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComposeAttachment, ComposeData } from '../../../shared/ipc'
import { fillTemplate, Template } from '../../../shared/types'
import { mergeFields } from '../../../shared/merge'
import { bid, mail, pathForFile, sys } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Menu } from '../components/ui'
import { fmtSize, modKey } from '../util'
import { AddressInput, Contact } from './AddressInput'
import { RichEditor, RichEditorHandle } from './RichEditor'

const SIG_START = '<div class="bm-sig">'

function withSignature(html: string, sig: string) {
  const cleaned = html.replace(/<div class="bm-sig">[\s\S]*?<\/div><!--\/sig-->/, '')
  if (!sig) return cleaned
  const block = `${SIG_START}${sig}</div><!--/sig-->`
  const q = cleaned.indexOf('<div class="bm-quote">')
  if (q > -1) return cleaned.slice(0, q) + block + cleaned.slice(q)
  return cleaned + block
}

export function Composer() {
  const { composeState: init, closeCompose, accounts, settings, toast, confirm, emailIndex, go, reloadFolders } = useApp()
  const firstAccount = accounts[0]?.id ?? ''
  const [accountId, setAccountId] = useState(init?.accountId || firstAccount)
  const [to, setTo] = useState(init?.to ?? '')
  const [cc, setCc] = useState(init?.cc ?? '')
  const [bcc, setBcc] = useState(init?.bcc ?? '')
  const [showCc, setShowCc] = useState(!!(init?.cc || init?.bcc))
  const [subject, setSubject] = useState(init?.subject ?? '')
  const [attachments, setAttachments] = useState<ComposeAttachment[]>(init?.attachments ?? [])
  const [sending, setSending] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [draft, setDraft] = useState(init?.draft)
  const [templates, setTemplates] = useState<Template[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const editor = useRef<RichEditorHandle>(null)
  const account = accounts.find((a) => a.id === accountId)

  const initialHtml = useMemo(() => {
    const base = init?.html ?? '<p><br></p>'
    return init?.draft ? base : withSignature(base, account?.signature ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    bid.listTemplates().then(setTemplates).catch(() => {})
    bid
      .listCompanies()
      .then((list) => {
        const c: Contact[] = []
        for (const co of list) {
          for (const e of co.email.split(/[;,\s]+/).filter((x) => x.includes('@'))) {
            c.push({ name: co.contactName || co.name, email: e, detail: co.contactName ? co.name : co.trades })
          }
        }
        for (const [email, matches] of emailIndex) {
          c.push({ name: matches[0].companyName, email, detail: `${matches[0].tradeName} · ${matches[0].jobName}` })
        }
        setContacts(c)
      })
      .catch(() => {})
  }, [emailIndex])

  const changeAccount = (id: string) => {
    setAccountId(id)
    const sig = accounts.find((a) => a.id === id)?.signature ?? ''
    const html = editor.current?.getHtml() ?? ''
    editor.current?.setHtml(withSignature(html, sig))
  }

  const data = (): ComposeData => ({
    accountId,
    to: to.trim().replace(/[,;]\s*$/, ''),
    cc: cc.trim().replace(/[,;]\s*$/, ''),
    bcc: bcc.trim().replace(/[,;]\s*$/, ''),
    subject,
    html: editor.current?.getHtml() ?? '',
    attachments,
    inReplyTo: init?.inReplyTo,
    references: init?.references,
    answered: init?.answered,
    draft
  })

  const send = async () => {
    if (!accountId) return toast('Add an email account in Settings first.', 'error')
    const d = data()
    if (!d.to && !d.cc && !d.bcc) return toast('Add at least one recipient.', 'error')
    if (!d.subject.trim() && !(await confirm({ title: 'No subject', message: 'Send this email without a subject?', confirmLabel: 'Send', danger: false }))) return
    if (/\battach/i.test(d.html.replace(/<div class="bm-quote">[\s\S]*/, '')) && !attachments.length &&
      !(await confirm({ title: 'Forgot an attachment?', message: 'Your message mentions an attachment, but nothing is attached. Send anyway?', confirmLabel: 'Send anyway', danger: false }))) return
    setSending(true)
    try {
      await mail.send(d)
      if (init?.bidderAction) {
        await bid.bidderAction(init.bidderAction.bidderId, init.bidderAction.action, { note: `Emailed: ${d.subject}` }).catch(() => {})
      }
      toast('Email sent', 'success')
      reloadFolders(accountId)
      closeCompose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSending(false)
    }
  }

  const saveDraft = async (close: boolean) => {
    try {
      const r = await mail.saveDraft(data())
      if (r) setDraft(r)
      setDirty(false)
      toast('Draft saved', 'success')
      reloadFolders(accountId)
      if (close) closeCompose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const close = async () => {
    if (dirty) {
      const ok = await confirm({ title: 'Discard this email?', message: 'Your changes have not been sent or saved.', confirmLabel: 'Discard' })
      if (!ok) return
    }
    closeCompose()
  }

  const addFiles = async () => {
    const files = await sys.openFiles()
    if (files.length) {
      setAttachments((a) => [...a, ...files.map((f) => ({ filename: f.name, path: f.path, size: f.size }))])
      setDirty(true)
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const list: ComposeAttachment[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = pathForFile(f)
      if (p) list.push({ filename: f.name, path: p, size: f.size })
    }
    if (list.length) {
      setAttachments((a) => [...a, ...list])
      setDirty(true)
    }
  }

  const insertTemplate = async (t: Template) => {
    let fields: Record<string, string> = { my_name: settings.userName, my_company: settings.companyName }
    if (init?.merge) {
      const d = await bid.getJob(init.merge.jobId)
      const trade = d?.trades.find((x) => x.bidders.some((b) => b.id === init.merge!.bidderId))
      const bidder = trade?.bidders.find((b) => b.id === init.merge!.bidderId)
      if (d && trade && bidder) fields = mergeFields(d.job, trade, bidder, { name: settings.userName, company: settings.companyName })
    }
    if (!subject.trim()) setSubject(fillTemplate(t.subject, fields, false))
    editor.current?.insertHtml(fillTemplate(t.body, fields, true))
    setDirty(true)
  }

  const totalSize = attachments.reduce((s, a) => s + (a.size ?? 0), 0)

  if (!accounts.length) {
    return (
      <div className="composer-backdrop">
        <div className="composer small">
          <div className="composer-head"><h2>New Email</h2><Button kind="ghost" icon="x" onClick={closeCompose} /></div>
          <div className="composer-empty">
            <p>Add an email account before sending mail.</p>
            <Button kind="primary" onClick={() => { closeCompose(); go({ kind: 'settings', tab: 'accounts' }) }}>Add account</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="composer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className={`composer ${dragOver ? 'drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            send()
          } else if (e.key === 'Escape') close()
        }}
      >
        <div className="composer-head">
          <h2>{init?.heading ?? 'New Email'}</h2>
          <Button kind="ghost" icon="x" title="Close" onClick={close} />
        </div>
        <div className="composer-fields">
          <div className="cf-row">
            <label>From</label>
            <select value={accountId} onChange={(e) => changeAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>
              ))}
            </select>
          </div>
          <div className="cf-row">
            <label>To</label>
            <AddressInput value={to} onChange={(v) => { setTo(v); setDirty(true) }} contacts={contacts} autoFocus={!to} placeholder="Name or email, separated by commas" />
            {!showCc && <button className="link-btn" onClick={() => setShowCc(true)}>Cc / Bcc</button>}
          </div>
          {showCc && (
            <>
              <div className="cf-row">
                <label>Cc</label>
                <AddressInput value={cc} onChange={(v) => { setCc(v); setDirty(true) }} contacts={contacts} />
              </div>
              <div className="cf-row">
                <label>Bcc</label>
                <AddressInput value={bcc} onChange={(v) => { setBcc(v); setDirty(true) }} contacts={contacts} />
              </div>
            </>
          )}
          <div className="cf-row">
            <label>Subject</label>
            <input value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true) }} autoFocus={!!to && !subject} />
          </div>
        </div>
        <div className="composer-editor">
          <RichEditor ref={editor} initialHtml={initialHtml} onChange={() => setDirty(true)} minHeight={300} />
        </div>
        {attachments.length > 0 && (
          <div className="composer-atts">
            {attachments.map((a, i) => (
              <span key={i} className="att-pill">
                <Icon name="paperclip" size={14} /> {a.filename} {a.size ? <span className="muted">({fmtSize(a.size)})</span> : null}
                <button title="Remove" onClick={() => setAttachments((l) => l.filter((_, j) => j !== i))}>
                  <Icon name="x" size={13} />
                </button>
              </span>
            ))}
            {totalSize > 20 * 1024 * 1024 && (
              <span className="warn-text">Over 20 MB. Many mail servers reject large attachments; send drawings as a link instead.</span>
            )}
          </div>
        )}
        {dragOver && <div className="drop-hint">Drop files to attach</div>}
        <div className="composer-foot">
          <Button kind="primary" icon="send" onClick={send} disabled={sending}>{sending ? 'Sending...' : 'Send'}</Button>
          <Button icon="paperclip" onClick={addFiles}>Attach</Button>
          <Menu
            trigger={(open) => <Button icon="template" onClick={open}>Template</Button>}
            items={
              templates.length
                ? templates.map((t) => ({ label: t.name, icon: 'template', onClick: () => insertTemplate(t) }))
                : [{ label: 'No templates yet', onClick: () => {}, disabled: true }]
            }
          />
          <span className="grow" />
          <span className="muted small">{modKey}+Enter to send</span>
          <Button icon="file" onClick={() => saveDraft(false)}>Save Draft</Button>
          <Button kind="ghost" icon="trash" title="Discard" onClick={close} />
        </div>
      </div>
    </div>
  )
}