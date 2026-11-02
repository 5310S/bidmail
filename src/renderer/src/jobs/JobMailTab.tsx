// A job's email folder: every email to or from the job's companies (or naming the job) in each account's Inbox,
// Sent and Archive, newest first. Nothing is moved; the emails stay where they are.
import { useCallback, useEffect, useState } from 'react'
import type { MessageDetail } from '../../../shared/ipc'
import type { JobDetail } from '../../../shared/types'
import type { JobMailItem } from '../../../shared/jobMail'
import { mail } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Spinner } from '../components/ui'
import { colorFor, cx, displayName, fmtListDate, initials } from '../util'
import { Reader } from '../mail/Reader'
import type { MailAction } from '../mail/MailView'

type Filter = 'all' | 'received' | 'sent'

export function JobMailTab({ detail }: { detail: JobDetail }) {
  const { accounts, folders, mailTick, reloadFolders, toast } = useApp()
  const jobId = detail.job.id
  const [rows, setRows] = useState<JobMailItem[] | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<JobMailItem | null>(null)
  const [message, setMessage] = useState<MessageDetail | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await mail.job(jobId)
      setRows(r.messages)
      setErrors(r.errors)
    } catch (e: any) {
      setErrors([e.message])
      setRows((x) => x ?? [])
    } finally {
      setBusy(false)
    }
  }, [jobId])

  useEffect(() => {
    load()
  }, [load, mailTick])

  const same = (a: JobMailItem, b: JobMailItem | null) => !!b && a.accountId === b.accountId && a.folder === b.folder && a.uid === b.uid
  const open = async (m: JobMailItem) => {
    setSelected(m)
    try {
      setMessage(await mail.get(m.accountId, m.folder, m.uid))
      setRows((l) => l?.map((x) => (same(x, m) ? { ...x, seen: true } : x)) ?? l)
      reloadFolders(m.accountId)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const act = async (kind: MailAction, dest?: string) => {
    if (!selected) return
    const { accountId, folder, uid } = selected
    try {
      if (kind === 'unread' || kind === 'read') {
        await mail.flags(accountId, folder, [uid], { seen: kind === 'read' })
        setRows((l) => l?.map((x) => (same(x, selected) ? { ...x, seen: kind === 'read' } : x)) ?? l)
      } else if (kind === 'flag' || kind === 'flagOn' || kind === 'flagOff') {
        const v = kind === 'flagOn' ? true : kind === 'flagOff' ? false : !message?.flagged
        await mail.flags(accountId, folder, [uid], { flagged: v })
        setMessage((d) => (d ? { ...d, flagged: v } : d))
      } else {
        if (kind === 'archive') await mail.archive(accountId, folder, [uid])
        else if (kind === 'delete') await mail.remove(accountId, folder, [uid])
        else if (dest) await mail.move(accountId, folder, [uid], dest)
        setMessage(null)
        setSelected(null)
        load()
      }
      reloadFolders(accountId)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const visible = (rows ?? []).filter((m) => filter === 'all' || (filter === 'sent') === m.sent)
  const acct = (id: string) => accounts.find((a) => a.id === id)

  if (!accounts.length) return <Empty icon="mail" title="No email account yet">Add your email in Settings &gt; Email Accounts to see this job's emails here.</Empty>
  return (
    <div className="job-mail">
      <div className="mail-view">
        <div className="msg-pane">
          <div className="msg-pane-head">
            <div className="msg-pane-title">
              <h2>{detail.job.name}</h2>
              <Button small icon="refresh" title="Look again" disabled={busy} onClick={() => load()} />
            </div>
            <div className="filter-chips">
              {(['all', 'received', 'sent'] as const).map((f) => (
                <button key={f} className={cx('chip', filter === f && 'on')} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'received' ? 'Received' : 'Sent'}
                </button>
              ))}
            </div>
          </div>
          <div className="msg-list">
            {errors.map((e) => <div key={e} className="list-error"><Icon name="alert" /> {e}</div>)}
            {rows === null && <Spinner label="Finding this job's emails..." />}
            {rows !== null && visible.length === 0 && (
              <Empty icon="mail" title="No emails for this job yet">
                Emails to and from this job's companies, and emails that name the job in the subject, show up here.
              </Empty>
            )}
            {visible.map((m) => {
              const a = acct(m.accountId)
              const person = m.sent ? m.to[0] : m.from[0]
              return (
                <div
                  key={`${m.accountId}|${m.folder}|${m.uid}`}
                  className={cx('msg-row', !m.seen && !m.sent && 'unread', same(m, selected) && 'selected')}
                  style={{ boxShadow: `inset 4px 0 0 ${a?.color ?? '#999'}` }}
                  onClick={() => open(m)}
                >
                  <div className="avatar" style={{ background: colorFor(person?.address ?? '') }}>{initials(displayName(person))}</div>
                  <div className="msg-main">
                    <div className="msg-line1">
                      <span className="msg-from ellipsis">{m.sent ? `To: ${displayName(person)}${m.to.length > 1 ? ` +${m.to.length - 1}` : ''}` : displayName(person)}</span>
                      <span className="msg-date">{fmtListDate(m.date)}</span>
                    </div>
                    <div className="msg-line2">
                      <span className="msg-subject ellipsis">{m.subject || '(no subject)'}</span>
                      <span className="msg-icons">{m.hasAttachments && <Icon name="paperclip" size={14} />}{m.flagged && <Icon name="star" size={14} className="flag-on" />}</span>
                    </div>
                    <div className="msg-acct ellipsis">{m.sent ? 'Sent' : 'Received'}{accounts.length > 1 ? ` · ${a?.displayName || a?.email}` : ''}</div>
                  </div>
                </div>
              )
            })}
            {rows !== null && rows.length > 0 && <div className="job-mail-note muted small">From Inbox, Sent and Archive. The emails stay where they are.</div>}
          </div>
        </div>
        <div className="reader-pane">
          {message && selected ? (
            <Reader key={message.key} message={message} folder={selected.folder} accountId={selected.accountId} folders={folders[selected.accountId] ?? []} onAction={act} />
          ) : (
            <Empty icon="mailOpen" title="Select an email to read" />
          )}
        </div>
      </div>
    </div>
  )
}
