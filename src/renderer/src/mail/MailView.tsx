import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageDetail, MessageSummary } from '../../../shared/ipc'
import { mail } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Empty, Menu, Spinner } from '../components/ui'
import { colorFor, cx, displayName, fmtDateTime, fmtListDate, initials, isMac } from '../util'
import { Reader } from './Reader'
import { folderIcon } from '../components/Sidebar'
import { threadMessages } from '../../../shared/threads'

const listCache = new Map<string, { messages: MessageSummary[]; hasMore: boolean }>()

export type MailAction = 'archive' | 'delete' | 'move' | 'unread' | 'read' | 'flag' | 'flagOn' | 'flagOff' | 'snoozed'

export function MailView({ accountId, folder, active }: { accountId: string; folder: string; active: boolean }) {
  const { folders, reloadFolders, mailTick, toast, emailIndex, openRequest, clearOpenRequest, go, settings, updateSettings } = useApp()
  const key = `${accountId}|${folder}`
  const [messages, setMessages] = useState<MessageSummary[]>(listCache.get(key)?.messages ?? [])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [offline, setOffline] = useState<{ reason: string; savedAt?: string } | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [multi, setMulti] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [detail, setDetail] = useState<MessageDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'unread' | 'flagged' | 'attach'>('all')
  const listRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0)

  const folderList = folders[accountId] ?? []
  const current = folderList.find((f) => f.path === folder)
  const isSentLike = current?.specialUse === '\\Sent' || current?.specialUse === '\\Drafts'

  const load = useCallback(
    async (silent = false) => {
      const id = ++reqId.current
      if (!silent) setLoading(true)
      try {
        const r = await mail.list(accountId, folder, 0, 60)
        if (id !== reqId.current) return
        setMessages(r.messages)
        setHasMore(r.hasMore)
        setError('')
        setOffline(r.offline ? { reason: r.offline, savedAt: r.savedAt } : null)
        listCache.set(key, { messages: r.messages, hasMore: r.hasMore })
      } catch (e: any) {
        if (id === reqId.current) setError(e.message)
      } finally {
        if (id === reqId.current) setLoading(false)
      }
    },
    [accountId, folder, key]
  )

  useEffect(() => {
    const c = listCache.get(key)
    setMessages(c?.messages ?? [])
    setHasMore(c?.hasMore ?? false)
    setSelected(null)
    setMulti(new Set())
    setDetail(null)
    setSearching(null)
    setQuery('')
    setOffline(null)
    load(!!c)
  }, [key, load])

  useEffect(() => {
    if (mailTick && !searching) load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailTick])

  // While offline, keep trying quietly so the list comes back by itself.
  useEffect(() => {
    if (!offline) return
    const t = setInterval(() => load(true), 30000)
    return () => clearInterval(t)
  }, [offline, load])

  const open = useCallback(
    async (uid: number) => {
      setSelected(uid)
      setDetailLoading(true)
      try {
        const d = await mail.get(accountId, folder, uid)
        setDetail(d)
        setMessages((list) => list.map((m) => (m.uid === uid ? { ...m, seen: true } : m)))
        reloadFolders(accountId)
      } catch (e: any) {
        toast(offline ? "You're offline and this message hasn't been downloaded to this computer yet." : e.message, 'error')
        setDetail(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [accountId, folder, reloadFolders, toast, offline]
  )

  useEffect(() => {
    if (openRequest && openRequest.accountId === accountId && openRequest.path === folder) {
      clearOpenRequest()
      load(true).then(() => open(openRequest.uid))
    }
  }, [openRequest, accountId, folder, clearOpenRequest, load, open])

  const loadMore = async () => {
    setLoading(true)
    try {
      const r = await mail.list(accountId, folder, messages.length, 60)
      const seen = new Set(messages.map((m) => m.uid))
      const next = [...messages, ...r.messages.filter((m) => !seen.has(m.uid))]
      setMessages(next)
      setHasMore(r.hasMore)
      listCache.set(key, { messages: next, hasMore: r.hasMore })
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const runSearch = async () => {
    const q = query.trim()
    if (!q) {
      setSearching(null)
      return load()
    }
    setLoading(true)
    setSearching(q)
    setMulti(new Set())
    try {
      const r = await mail.search(accountId, folder, q)
      setMessages(r.messages)
      setHasMore(false)
    } catch (e: any) {
      toast(offline ? "Search needs an internet connection." : e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const filtered = messages.filter((m) =>
    filter === 'unread' ? !m.seen : filter === 'flagged' ? m.flagged : filter === 'attach' ? m.hasAttachments : true
  )
  // Conversation view: one row per conversation (its newest message); actions apply to the whole conversation.
  const conversations = settings.reading.conversations && !searching
  const convs = conversations ? threadMessages(filtered) : []
  const convOf = new Map(convs.map((c) => [c.latest.uid, c]))
  const visible = conversations ? convs.map((c) => c.latest) : filtered

  // The messages an action applies to: the checked ones, or the one being read (whole conversations when grouped).
  const expand = (uid: number) => convOf.get(uid)?.messages.map((m) => m.uid) ?? [uid]
  const targets = (): number[] => {
    const base = multi.size ? [...multi] : selected != null ? [selected] : []
    return conversations ? [...new Set(base.flatMap(expand))] : base
  }
  const isMulti = multi.size > 1

  const onRowClick = (e: React.MouseEvent, uid: number) => {
    if (e.shiftKey && anchor != null) {
      const a = visible.findIndex((m) => m.uid === anchor)
      const b = visible.findIndex((m) => m.uid === uid)
      if (a > -1 && b > -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setMulti(new Set(visible.slice(lo, hi + 1).map((m) => m.uid)))
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      toggle(uid)
      return
    }
    setMulti(new Set())
    setAnchor(uid)
    open(uid)
  }

  const toggle = (uid: number) => {
    const n = new Set(multi.size ? multi : selected != null ? [selected] : [])
    if (n.has(uid)) n.delete(uid)
    else n.add(uid)
    setMulti(n)
    setAnchor(uid)
    if (n.size === 1) open([...n][0])
  }

  const removeFromList = (uids: number[]) => {
    const set = new Set(uids)
    const idx = visible.findIndex((m) => set.has(m.uid))
    const remaining = visible.filter((m) => !set.has(m.uid))
    const single = multi.size <= 1
    const next = single && idx > -1 ? remaining[Math.min(idx, remaining.length - 1)] : undefined
    setMessages((list) => {
      const l = list.filter((m) => !set.has(m.uid))
      listCache.set(key, { messages: l, hasMore })
      return l
    })
    setDetail(null)
    setMulti(new Set())
    if (next) open(next.uid)
    else setSelected(null)
  }

  const act = async (kind: MailAction, dest?: string) => {
    if (kind === 'snoozed') {
      if (detail) removeFromList([detail.uid])
      reloadFolders(accountId)
      return
    }
    const uids = targets()
    if (!uids.length) return
    const n = uids.length
    const label = n > 1 ? `${n} messages` : 'Message'
    try {
      if (kind === 'unread' || kind === 'read') {
        const seen = kind === 'read'
        await mail.flags(accountId, folder, uids, { seen })
        setMessages((l) => l.map((m) => (uids.includes(m.uid) ? { ...m, seen } : m)))
        if (!seen && n === 1) {
          setDetail(null)
          setSelected(null)
        }
        if (n > 1) toast(`${label} marked ${seen ? 'read' : 'unread'}`, 'success')
      } else if (kind === 'flag' || kind === 'flagOn' || kind === 'flagOff') {
        const first = messages.find((m) => m.uid === uids[0])
        const v = kind === 'flagOn' ? true : kind === 'flagOff' ? false : !(detail?.flagged ?? first?.flagged)
        await mail.flags(accountId, folder, uids, { flagged: v })
        setMessages((l) => l.map((m) => (uids.includes(m.uid) ? { ...m, flagged: v } : m)))
        setDetail((d) => (d && uids.includes(d.uid) ? { ...d, flagged: v } : d))
      } else {
        removeFromList(uids)
        if (kind === 'archive') await mail.archive(accountId, folder, uids)
        else if (kind === 'delete') await mail.remove(accountId, folder, uids)
        else if (dest) await mail.move(accountId, folder, uids, dest)
        toast(`${label} ${kind === 'archive' ? 'archived' : kind === 'delete' ? 'deleted' : 'moved'}`, 'success')
      }
      reloadFolders(accountId)
    } catch (e: any) {
      toast(offline ? 'That needs an internet connection.' : e.message, 'error')
      load(true)
    }
  }

  // Keyboard: Up/Down move, Shift+Up/Down extend, Ctrl/Cmd+A select all, Esc clears, Delete deletes.
  useEffect(() => {
    if (!active) return
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable="true"], .modal, .composer')) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const idx = visible.findIndex((m) => m.uid === selected)
        const n = visible[e.key === 'ArrowDown' ? idx + 1 : Math.max(0, idx - 1)]
        if (!n) return
        if (e.shiftKey) {
          const base = multi.size ? new Set(multi) : new Set(selected != null ? [selected] : [])
          base.add(n.uid)
          setMulti(base)
          setSelected(n.uid)
        } else {
          setMulti(new Set())
          open(n.uid)
        }
        listRef.current?.querySelector(`[data-uid="${n.uid}"]`)?.scrollIntoView({ block: 'nearest' })
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setMulti(new Set(visible.map((m) => m.uid)))
      } else if (e.key === 'Escape' && multi.size) {
        setMulti(new Set())
      } else if ((e.key === 'Delete' || (isMac && e.key === 'Backspace')) && targets().length) {
        act('delete')
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const allChecked = visible.length > 0 && visible.every((m) => multi.has(m.uid))
  const moveItems = folderList
    .filter((f) => f.path !== folder)
    .map((f) => ({ label: f.name, icon: folderIcon(f), onClick: () => act('move', f.path) }))

  return (
    <div className="mail-view">
      <div className="msg-pane">
        <div className="msg-pane-head">
          <div className="msg-pane-title">
            <h2>{current?.name ?? folder}</h2>
            <Button small icon="refresh" title="Refresh" onClick={() => { load(); reloadFolders(accountId) }} />
          </div>
          <form
            className="search-box"
            onSubmit={(e) => {
              e.preventDefault()
              runSearch()
            }}
          >
            <Icon name="search" size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this folder (press Enter)" />
            {searching && (
              <button type="button" className="link-btn" onClick={() => { setQuery(''); setSearching(null); load() }}>
                Clear
              </button>
            )}
          </form>
          <div className="filter-chips">
            {(['all', 'unread', 'flagged', 'attach'] as const).map((f) => (
              <button key={f} className={cx('chip', filter === f && 'on')} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'unread' ? 'Unread' : f === 'flagged' ? 'Flagged' : 'Attachments'}
              </button>
            ))}
            <button
              className={cx('chip', conversations && 'on')}
              title="Group replies into conversations"
              onClick={() => updateSettings({ reading: { ...settings.reading, conversations: !settings.reading.conversations } })}
            >
              Conversations
            </button>
            <label className="select-all" title={`Select all (${isMac ? '⌘' : 'Ctrl'}+A)`}>
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => setMulti(e.target.checked ? new Set(visible.map((m) => m.uid)) : new Set())}
              />
              {multi.size > 1 ? `${multi.size} selected` : 'Select'}
            </label>
          </div>
        </div>
        {offline && (
          <div className="offline-bar" title={offline.reason}>
            <Icon name="wifiOff" size={15} />
            <span className="grow">Offline. Showing mail saved on this computer{offline.savedAt ? ` (as of ${fmtDateTime(offline.savedAt)})` : ''}.</span>
            <button className="link-btn" onClick={() => load()}>Retry</button>
          </div>
        )}
        <div className={cx('msg-list', multi.size > 0 && 'multi')} ref={listRef}>
          {error && (
            <div className="list-error">
              <Icon name="alert" /> {error}
              <div><Button small onClick={() => go({ kind: 'settings', tab: 'accounts' })}>Check account settings</Button> <Button small onClick={() => load()}>Retry</Button></div>
            </div>
          )}
          {loading && messages.length === 0 && <Spinner label="Loading messages..." />}
          {!loading && !error && visible.length === 0 && (
            <Empty title={searching ? 'No matches' : 'Nothing here'}>{searching ? `No messages match "${searching}".` : 'This folder is empty.'}</Empty>
          )}
          {visible.map((m) => {
            const person = isSentLike ? m.to[0] : m.from[0]
            const addr = (m.from[0]?.address ?? '').toLowerCase()
            const match = !isSentLike ? emailIndex.get(addr)?.[0] : undefined
            const checked = multi.has(m.uid)
            const conv = convOf.get(m.uid)
            const unread = conv ? conv.unread > 0 : !m.seen
            return (
              <div
                key={m.uid}
                data-uid={m.uid}
                className={cx('msg-row', unread && 'unread', selected === m.uid && !isMulti && 'selected', checked && 'checked')}
                onClick={(e) => onRowClick(e, m.uid)}
              >
                <div className="msg-avatar-wrap">
                  <div className="avatar" style={{ background: colorFor(person?.address ?? '') }}>{initials(displayName(person))}</div>
                  <label className="msg-check" onClick={(e) => e.stopPropagation()} title="Select">
                    <input type="checkbox" checked={checked} onChange={() => toggle(m.uid)} />
                  </label>
                </div>
                <div className="msg-main">
                  <div className="msg-line1">
                    <span className="msg-from ellipsis">
                      {isSentLike && <span className="muted">To: </span>}
                      {displayName(person)}
                      {conv && conv.messages.length > 1 && <span className="conv-count">{conv.messages.length}</span>}
                      {isSentLike && m.to.length > 1 && <span className="muted"> +{m.to.length - 1}</span>}
                    </span>
                    <span className="msg-date">{fmtListDate(m.date)}</span>
                  </div>
                  <div className="msg-line2">
                    <span className="msg-subject ellipsis">{m.subject || '(no subject)'}</span>
                    <span className="msg-icons">
                      {m.answered && <Icon name="reply" size={14} title="Replied" />}
                      {(conv ? conv.hasAttachments : m.hasAttachments) && <Icon name="paperclip" size={14} title="Has attachments" />}
                      {(conv ? conv.flagged : m.flagged) && <Icon name="star" size={14} className="flag-on" title="Flagged" />}
                    </span>
                  </div>
                  {match && (
                    <div className="msg-job ellipsis" title={`${match.companyName} - ${match.tradeName} - ${match.jobName}`}>
                      <Icon name="briefcase" size={12} /> {match.jobName} · {match.tradeName}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {hasMore && !searching && !offline && (
            <div className="load-more">
              <Button small onClick={loadMore} disabled={loading}>{loading ? 'Loading...' : 'Load older messages'}</Button>
            </div>
          )}
        </div>
      </div>
      <div className="reader-pane">
        {isMulti ? (
          <div className="bulk-panel">
            <Icon name="checkSquare" size={44} />
            <h2>{multi.size} messages selected</h2>
            <div className="bulk-actions">
              <Button icon="mailOpen" onClick={() => act('read')}>Mark read</Button>
              <Button icon="mail" onClick={() => act('unread')}>Mark unread</Button>
              <Button icon="star" onClick={() => act('flagOn')}>Flag</Button>
              <Button onClick={() => act('flagOff')}>Remove flag</Button>
              <Button icon="archive" onClick={() => act('archive')}>Archive</Button>
              <Menu trigger={(openMenu) => <Button icon="move" onClick={openMenu}>Move to...</Button>} items={moveItems} />
              <Button kind="danger" icon="trash" onClick={() => act('delete')}>Delete</Button>
            </div>
            <button className="link-btn" onClick={() => setMulti(new Set())}>Clear selection (Esc)</button>
            <div className="small">Tip: {isMac ? '⌘' : 'Ctrl'}+click picks messages one by one; Shift+click picks a range.</div>
          </div>
        ) : (
          <>
            {detailLoading && !detail && <Spinner label="Opening message..." />}
            {detail && (
              <Reader
                key={detail.key}
                message={detail}
                folder={folder}
                accountId={accountId}
                folders={folderList}
                onAction={act}
                thread={conversations ? convOf.get(detail.uid)?.messages.filter((x) => x.uid !== detail.uid) : undefined}
              />
            )}
            {!detail && !detailLoading && <Empty icon="mailOpen" title="Select a message to read" />}
          </>
        )}
      </div>
    </div>
  )
}