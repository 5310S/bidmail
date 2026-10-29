// All Inboxes: every account's Inbox in one list, newest first.
import { useCallback, useEffect, useState } from 'react'
import type { MessageDetail, MessageSummary } from '../../../shared/ipc'
import { mail } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Spinner } from '../components/ui'
import { colorFor, cx, displayName, fmtListDate, initials, isMac } from '../util'
import { Reader } from './Reader'
import type { MailAction } from './MailView'

interface Row extends MessageSummary {
  accountId: string
}

export function UnifiedInbox() {
  const { accounts, folders, mailTick, reloadFolders, toast, emailIndex } = useApp()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<string[]>([])
  const [selected, setSelected] = useState<{ accountId: string; uid: number } | null>(null)
  const [detail, setDetail] = useState<MessageDetail | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)

  const load = useCallback(async () => {
    const results = await Promise.allSettled(accounts.map((a) => mail.list(a.id, 'INBOX', 0, 60).then((l) => l.messages.map((m) => ({ ...m, accountId: a.id })))))
    const all: Row[] = []
    const errs: string[] = []
    results.forEach((r, i) => (r.status === 'fulfilled' ? all.push(...r.value) : errs.push(`${accounts[i].email}: ${r.reason?.message ?? r.reason}`)))
    all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    setRows(all)
    setErrors(errs)
    setLoading(false)
  }, [accounts])

  useEffect(() => {
    load()
  }, [load, mailTick])

  const visible = rows.filter((r) => !unreadOnly || !r.seen)
  const open = async (r: Row) => {
    setSelected({ accountId: r.accountId, uid: r.uid })
    try {
      setDetail(await mail.get(r.accountId, 'INBOX', r.uid))
      setRows((l) => l.map((x) => (x.accountId === r.accountId && x.uid === r.uid ? { ...x, seen: true } : x)))
      reloadFolders(r.accountId)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const act = async (kind: MailAction, dest?: string) => {
    if (!selected) return
    const { accountId, uid } = selected
    try {
      if (kind === 'unread' || kind === 'read') await mail.flags(accountId, 'INBOX', [uid], { seen: kind === 'read' })
      else if (kind === 'flag' || kind === 'flagOn' || kind === 'flagOff') {
        const v = kind === 'flagOn' ? true : kind === 'flagOff' ? false : !detail?.flagged
        await mail.flags(accountId, 'INBOX', [uid], { flagged: v })
        setDetail((d) => (d ? { ...d, flagged: v } : d))
      } else {
        const idx = visible.findIndex((r) => r.accountId === accountId && r.uid === uid)
        if (kind === 'archive') await mail.archive(accountId, 'INBOX', [uid])
        else if (kind === 'delete') await mail.remove(accountId, 'INBOX', [uid])
        else if (dest) await mail.move(accountId, 'INBOX', [uid], dest)
        const rest = visible.filter((r) => !(r.accountId === accountId && r.uid === uid))
        setRows((l) => l.filter((r) => !(r.accountId === accountId && r.uid === uid)))
        setDetail(null)
        const next = rest[Math.min(idx, rest.length - 1)]
        if (next) open(next)
        else setSelected(null)
      }
      reloadFolders(accountId)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], .modal, .composer')) return
      const idx = visible.findIndex((r) => selected && r.accountId === selected.accountId && r.uid === selected.uid)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = visible[e.key === 'ArrowDown' ? idx + 1 : Math.max(0, idx - 1)]
        if (n) open(n)
      } else if ((e.key === 'Delete' || (isMac && e.key === 'Backspace')) && selected) act('delete')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const acct = (id: string) => accounts.find((a) => a.id === id)
  return (
    <div className="mail-view">
      <div className="msg-pane">
        <div className="msg-pane-head">
          <div className="msg-pane-title">
            <h2>All Inboxes</h2>
            <Button small icon="refresh" title="Refresh" onClick={() => { load(); reloadFolders() }} />
          </div>
          <div className="filter-chips">
            <button className={cx('chip', !unreadOnly && 'on')} onClick={() => setUnreadOnly(false)}>All</button>
            <button className={cx('chip', unreadOnly && 'on')} onClick={() => setUnreadOnly(true)}>Unread</button>
          </div>
        </div>
        <div className="msg-list">
          {errors.map((e) => <div key={e} className="list-error"><Icon name="alert" /> {e}</div>)}
          {loading && <Spinner label="Loading inboxes..." />}
          {!loading && visible.length === 0 && <Empty title="Nothing here" />}
          {visible.map((m) => {
            const a = acct(m.accountId)
            const person = m.from[0]
            const match = emailIndex.get((person?.address ?? '').toLowerCase())?.[0]
            return (
              <div
                key={m.accountId + m.uid}
                className={cx('msg-row', !m.seen && 'unread', selected?.accountId === m.accountId && selected.uid === m.uid && 'selected')}
                style={{ boxShadow: `inset 4px 0 0 ${a?.color ?? '#999'}` }}
                onClick={() => open(m)}
              >
                <div className="avatar" style={{ background: colorFor(person?.address ?? '') }}>{initials(displayName(person))}</div>
                <div className="msg-main">
                  <div className="msg-line1">
                    <span className="msg-from ellipsis">{displayName(person)}</span>
                    <span className="msg-date">{fmtListDate(m.date)}</span>
                  </div>
                  <div className="msg-line2">
                    <span className="msg-subject ellipsis">{m.subject || '(no subject)'}</span>
                    <span className="msg-icons">{m.hasAttachments && <Icon name="paperclip" size={14} />}{m.flagged && <Icon name="star" size={14} className="flag-on" />}</span>
                  </div>
                  <div className="msg-acct ellipsis">{a?.displayName || a?.email}{match ? ` · ${match.jobName}` : ''}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="reader-pane">
        {detail && selected ? (
          <Reader key={detail.key} message={detail} folder="INBOX" accountId={selected.accountId} folders={folders[selected.accountId] ?? []} onAction={act} />
        ) : (
          <Empty icon="mailOpen" title="Select a message to read" />
        )}
      </div>
    </div>
  )
}