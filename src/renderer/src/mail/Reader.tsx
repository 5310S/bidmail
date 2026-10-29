import { useCallback, useEffect, useState } from 'react'
import type { MailFolder, MessageDetail, MessageSummary } from '../../../shared/ipc'
import type { EmailMatch } from '../../../shared/types'
import { useApp } from '../state'
import { bid, files, mail, snooze, sys } from '../api'
import { setRuleDraft } from '../settings/RulesTab'
import { useBidQuery } from '../state'
import { buildEventIcs } from '../../../shared/ics'
import { buildPrintDoc } from './printDoc'
import { Icon } from '../components/Icon'
import { Button, Field, Menu, Modal, Popover } from '../components/ui'
import { addrText, colorFor, cx, displayName, fmtFullDate, fmtSize, fromLocalInput, initials, parseMoney, toLocalInput } from '../util'
import { MessageBody } from './MessageBody'
import { forwardInit, replyInit } from './compose'
import { folderIcon } from '../components/Sidebar'

export function Reader({
  message, folder, accountId, folders, onAction, thread
}: {
  message: MessageDetail
  folder: string
  accountId: string
  folders: MailFolder[]
  onAction: (kind: 'archive' | 'delete' | 'move' | 'unread' | 'flag' | 'snoozed', dest?: string) => void
  /** Other messages in this conversation (newest first), shown above the message. */
  thread?: MessageSummary[]
}) {
  const { settings, updateSettings, accounts, compose, emailIndex, toast, go } = useApp()
  const [snoozePop, setSnoozePop] = useState<DOMRect | null>(null)
  const [snoozeAt, setSnoozeAt] = useState('')
  const inSnoozed = folders.find((f) => f.path === folder)?.name === 'Snoozed'
  const doSnooze = async (until: Date) => {
    try {
      await snooze.add(accountId, folder, message.uid, until.toISOString())
      toast(`Snoozed until ${until.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, 'success')
      onAction('snoozed')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  const unsnooze = async () => {
    const s = (await snooze.list()).find((x) => x.accountId === accountId && x.messageId === message.messageId)
    if (!s) return toast('This message is not in the snooze list. Move it back with the Move button.', 'error')
    await snooze.wake(s.id)
    toast('Moved back to the Inbox', 'success')
    onAction('snoozed')
  }
  const [allowOnce, setAllowOnce] = useState(false)
  const [blocked, setBlocked] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  const me = accounts.find((a) => a.id === accountId)
  const sender = message.from[0]?.address?.toLowerCase() ?? ''
  const trusted = settings.trustedImageSenders.includes(sender)
  const allowImages = settings.reading.loadRemoteImages || trusted || allowOnce
  const fontSize = settings.reading.fontSize
  const simple = settings.reading.simpleView
  const onBlocked = useCallback((n: number) => setBlocked(n), [])
  const matches = emailIndex.get(sender) ?? []

  const setReading = (patch: Partial<typeof settings.reading>) => updateSettings({ reading: { ...settings.reading, ...patch } })
  const isDraft = message.draft

  const openAttachment = (id: string) => mail.openAttachment(message.key, id).catch((e) => toast(e.message, 'error'))
  const saveAttachment = (id: string) =>
    mail.saveAttachment(message.key, id).then((p) => p && toast('Saved to ' + p, 'success')).catch((e) => toast(e.message, 'error'))
  const saveAll = (dir?: string) =>
    mail
      .saveAll(message.key, message.attachments.map((a) => a.id), dir)
      .then((r) => r && toast(`Saved ${r.files.length} file(s) to ${r.dir}`, 'success'))
      .catch((e) => toast(e.message, 'error'))

  return (
    <div className="reader">
      <div className="reader-toolbar">
        {isDraft ? (
          <Button
            kind="primary"
            icon="edit"
            onClick={() =>
              compose({
                heading: 'Edit Draft',
                accountId,
                to: addrText(message.to),
                cc: addrText(message.cc),
                bcc: addrText(message.bcc),
                subject: message.subject,
                html: message.html || message.text.replace(/\n/g, '<br>'),
                attachments: message.attachments.map((a) => ({ filename: a.filename, size: a.size, source: { key: message.key, id: a.id } })),
                draft: { path: folder, uid: message.uid }
              })
            }
          >
            Edit Draft
          </Button>
        ) : (
          <>
            <Button className="collapse-label" icon="reply" title="Reply" onClick={() => compose(replyInit(message, folder, accountId, me, false))}>Reply</Button>
            <Button className="collapse-label" icon="replyAll" title="Reply All" onClick={() => compose(replyInit(message, folder, accountId, me, true))}>Reply All</Button>
            <Button className="collapse-label" icon="forward" title="Forward" onClick={() => compose(forwardInit(message, accountId))}>Forward</Button>
          </>
        )}
        <span className="tb-sep" />
        <Button icon="archive" title="Archive" onClick={() => onAction('archive')} />
        <Button icon="trash" title="Delete (Del)" onClick={() => onAction('delete')} />
        <Menu
          trigger={(open) => <Button icon="move" title="Move to folder" onClick={open} />}
          items={folders
            .filter((f) => f.path !== folder)
            .map((f) => ({ label: f.name, icon: folderIcon(f), onClick: () => onAction('move', f.path) }))}
        />
        <Button icon="mail" title="Mark as unread" onClick={() => onAction('unread')} />
        <Button icon="star" title={message.flagged ? 'Remove flag' : 'Flag'} className={message.flagged ? 'flag-on' : ''} onClick={() => onAction('flag')} />
        {inSnoozed ? (
          <Button icon="clock" title="Return to the Inbox now" onClick={unsnooze}>Unsnooze</Button>
        ) : (
          <Menu
            trigger={(open) => <Button icon="clock" title="Snooze: hide until later" onClick={open} />}
            items={[
              { label: 'Later today (in 3 hours)', icon: 'clock', onClick: () => doSnooze(new Date(Date.now() + 3 * 3600000)) },
              { label: 'Tomorrow morning (8 AM)', icon: 'sun', onClick: () => doSnooze(atHour(1, 8)) },
              { label: 'Next Monday (8 AM)', icon: 'calendar', onClick: () => doSnooze(nextWeekday(1, 8)) },
              { label: 'In one week', icon: 'calendar', onClick: () => doSnooze(atHour(7, 8)) },
              {
                label: 'Pick a date & time...',
                icon: 'edit',
                onClick: () => {
                  setSnoozeAt(toLocalInput(atHour(1, 8).toISOString()))
                  setSnoozePop(document.querySelector('.reader-toolbar')!.getBoundingClientRect())
                }
              }
            ]}
          />
        )}
        <Menu
          trigger={(open) => <Button icon="more" title="More: print, PDF, rules" onClick={open} />}
          items={[
            { label: 'Print...', icon: 'printer', onClick: () => sys.print(buildPrintDoc(message, allowImages)).catch((e) => toast(e.message, 'error')) },
            {
              label: 'Save as PDF...',
              icon: 'download',
              onClick: () =>
                sys
                  .savePdf(buildPrintDoc(message, allowImages), message.subject.slice(0, 80) || 'Email')
                  .then((p) => p && toast('Saved PDF to ' + p, 'success'))
                  .catch((e) => toast(e.message, 'error'))
            },
            'sep',
            {
              label: `Create a rule for mail from ${message.from[0]?.address ?? 'this sender'}...`,
              icon: 'settings',
              onClick: () => {
                setRuleDraft({
                  name: `Mail from ${message.from[0]?.name || message.from[0]?.address}`,
                  accountId,
                  conditions: [{ field: 'from', op: 'contains', value: message.from[0]?.address ?? '' }]
                })
                go({ kind: 'settings', tab: 'rules' })
              }
            }
          ]}
        />
        <span className="grow" />
        <div className="text-size" title="Text size">
          <button onClick={() => setReading({ fontSize: Math.max(12, fontSize - 1) })}>A-</button>
          <span>{fontSize}</span>
          <button onClick={() => setReading({ fontSize: Math.min(28, fontSize + 1) })}>A+</button>
        </div>
        <Button
          small
          icon="type"
          kind={simple ? 'primary' : 'default'}
          title="Simple view: plain, large, easy-to-read text"
          onClick={() => setReading({ simpleView: !simple })}
        >
          Simple
        </Button>
      </div>

      <div className="reader-scroll">
        <h1 className="reader-subject">{message.subject}</h1>
        {thread && thread.length > 0 && <ThreadHistory thread={thread} accountId={accountId} folder={folder} />}
        <div className="reader-head">
          <div className="avatar lg" style={{ background: colorFor(sender) }}>{initials(displayName(message.from[0]))}</div>
          <div className="grow">
            <div className="reader-from">
              <b>{displayName(message.from[0])}</b> <span className="muted">&lt;{message.from[0]?.address}&gt;</span>
            </div>
            <div className="reader-to muted">
              To: {addrText(message.to) || '(none)'}
              {message.cc.length > 0 && <> &nbsp;·&nbsp; Cc: {addrText(message.cc)}</>}
              <button className="link-btn" onClick={() => setShowDetails((s) => !s)}>{showDetails ? 'less' : 'details'}</button>
            </div>
            {showDetails && (
              <div className="reader-details muted">
                {message.replyTo.length > 0 && <div>Reply-To: {addrText(message.replyTo)}</div>}
                {message.bcc.length > 0 && <div>Bcc: {addrText(message.bcc)}</div>}
                <div>Size: {fmtSize(message.size)}</div>
              </div>
            )}
          </div>
          <div className="reader-date muted">{fmtFullDate(message.date)}</div>
        </div>

        {message.fromCache && (
          <div className="offline-note"><Icon name="wifiOff" size={15} /> You're offline. This is the copy saved on this computer.</div>
        )}

        <JobLinkPanel matches={matches} message={message} onSaveAll={saveAll} />
        {snoozePop && (
          <Popover anchor={snoozePop} onClose={() => setSnoozePop(null)} width={280}>
            <div className="pop-title">Snooze until</div>
            <input type="datetime-local" value={snoozeAt} onChange={(e) => setSnoozeAt(e.target.value)} />
            <div className="pop-actions">
              <Button small onClick={() => setSnoozePop(null)}>Cancel</Button>
              <Button small kind="primary" onClick={() => { const d = fromLocalInput(snoozeAt); setSnoozePop(null); if (d) doSnooze(new Date(d)) }}>Snooze</Button>
            </div>
          </Popover>
        )}

        {message.invite && <InviteCard message={message} accountId={accountId} />}

        {message.attachments.length > 0 && (
          <div className="attachments">
            {message.attachments.map((a) => (
              <div key={a.id} className="att-chip" title={`${a.filename} (${fmtSize(a.size)})`}>
                <button className="att-main" onClick={() => openAttachment(a.id)}>
                  <Icon name={/pdf/i.test(a.contentType) ? 'file' : /image/.test(a.contentType) ? 'image' : 'paperclip'} />
                  <span className="att-name">{a.filename}</span>
                  <span className="muted">{fmtSize(a.size)}</span>
                </button>
                <button className="att-save" title="Save as..." onClick={() => saveAttachment(a.id)}>
                  <Icon name="download" size={15} />
                </button>
              </div>
            ))}
            {message.attachments.length > 1 && (
              <Button small icon="download" onClick={() => saveAll()}>Save all</Button>
            )}
          </div>
        )}

        {blocked > 0 && !allowImages && (
          <div className="images-bar">
            <Icon name="image" />
            <span>Pictures were blocked to protect your privacy.</span>
            <button className="link-btn" onClick={() => setAllowOnce(true)}>Show pictures</button>
            <button
              className="link-btn"
              onClick={() => updateSettings({ trustedImageSenders: [...settings.trustedImageSenders, sender] })}
            >
              Always show from {sender}
            </button>
          </div>
        )}

        <div className={simple ? 'body-card simple' : 'body-card'}>
          <MessageBody html={message.html} text={message.text} allowImages={allowImages} simple={simple} fontSize={fontSize} onBlocked={onBlocked} />
        </div>
      </div>
    </div>
  )
}

/** Shows which job/trade/company an email belongs to, with one-click status updates. */
function JobLinkPanel({ matches, message, onSaveAll }: { matches: EmailMatch[]; message: MessageDetail; onSaveAll: (dir?: string) => void }) {
  const { go, toast, jobs } = useApp()
  const [pricePop, setPricePop] = useState<{ match: EmailMatch; rect: DOMRect } | null>(null)
  const [amount, setAmount] = useState('')
  const [at, setAt] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  if (!matches.length) {
    return (
      <div className="joblink joblink-none">
        <Icon name="briefcase" size={16} />
        <span className="muted">This sender is not on any open job.</span>
        <button className="link-btn" onClick={() => setAddOpen(true)}>Add sender to a job...</button>
        {addOpen && <AddSenderModal message={message} onClose={() => setAddOpen(false)} />}
      </div>
    )
  }

  const record = async (m: EmailMatch, action: 'price_received' | 'declined' | 'will_bid', extra: { amount?: number | null; at?: string } = {}) => {
    try {
      await bid.bidderAction(m.bidderId, action, { ...extra, note: `From email: ${message.subject}` })
      toast(`${m.companyName}: ${action === 'price_received' ? 'price received' : action === 'will_bid' ? 'will bid' : 'not bidding'} on ${m.jobName}`, 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div className="joblink">
      {matches.map((m) => {
        const job = jobs.find((j) => j.id === m.jobId)
        return (
          <div key={m.bidderId} className="joblink-row">
            <Icon name="briefcase" size={16} />
            <span className="joblink-text">
              <b>{m.companyName}</b> · {m.tradeName} · <button className="link-btn" onClick={() => go({ kind: 'job', jobId: m.jobId })}>{m.jobName}</button>
            </span>
            <span className="grow" />
            <Button
              small
              kind="success"
              icon="dollar"
              onClick={(e) => {
                setAmount('')
                setAt(toLocalInput(message.date))
                setPricePop({ match: m, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })
              }}
            >
              Price Received
            </Button>
            <Button small icon="check" onClick={() => record(m, 'will_bid', { at: message.date })}>Will Bid</Button>
            <Button small icon="ban" onClick={() => record(m, 'declined', { at: message.date })}>Not Bidding</Button>
            {message.attachments.length > 0 && (
              <Button
                small
                icon="paperclip"
                title="Keep the attached quote with this company on the job (shared with your team)"
                onClick={() =>
                  files
                    .fromAttachments(message.key, message.attachments.map((a) => a.id), m.jobId, m.bidderId)
                    .then((r) => toast(`Saved ${r.length} file(s) to ${m.companyName} on ${m.jobName}`, 'success'))
                    .catch((e) => toast(e.message, 'error'))
                }
              >
                Save quote to company
              </Button>
            )}
            <AddendumAckMenu match={m} />
            {job?.folderPath && message.attachments.length > 0 && (
              <Button small icon="download" title={job.folderPath} onClick={() => onSaveAll(job.folderPath)}>Save files to job folder</Button>
            )}
          </div>
        )
      })}
      {pricePop && (
        <Popover anchor={pricePop.rect} onClose={() => setPricePop(null)} width={280}>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              record(pricePop.match, 'price_received', { amount: parseMoney(amount), at: fromLocalInput(at) ?? undefined })
              setPricePop(null)
            }}
          >
            <div className="pop-title">Price from {pricePop.match.companyName}</div>
            <Field label="Amount (optional)">
              <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" />
            </Field>
            <Field label="Received">
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
            <div className="pop-actions">
              <Button onClick={() => setPricePop(null)}>Cancel</Button>
              <Button kind="success" type="submit">Save</Button>
            </div>
          </form>
        </Popover>
      )}
    </div>
  )
}

function AddSenderModal({ message, onClose }: { message: MessageDetail; onClose: () => void }) {
  const { jobs, toast } = useApp()
  const open = jobs.filter((j) => j.status === 'bidding' || j.status === 'submitted')
  const from = message.from[0]
  const domain = from?.address.split('@')[1] ?? ''
  const [jobId, setJobId] = useState(open[0]?.id ?? '')
  const [tradeId, setTradeId] = useState('')
  const [trades, setTrades] = useState<{ id: string; name: string }[]>([])
  const [company, setCompany] = useState(domain && !/gmail|yahoo|outlook|hotmail|aol|icloud/i.test(domain) ? domain.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()) : '')
  const [contact, setContact] = useState(from?.name ?? '')
  const [saving, setSaving] = useState(false)

  const loadTrades = (id: string) => {
    setJobId(id)
    bid.getJob(id).then((d) => {
      const t = d?.trades.map((x) => ({ id: x.id, name: x.name })) ?? []
      setTrades(t)
      setTradeId(t[0]?.id ?? '')
    })
  }
  useEffect(() => {
    if (jobId) loadTrades(jobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    if (!tradeId) return toast('Pick a trade (add trades to the job first).', 'error')
    setSaving(true)
    try {
      await bid.addBidder(tradeId, { companyName: company || from?.address, contactName: contact, email: from?.address ?? '' })
      toast('Added to job', 'success')
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Add sender to a job"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={save} disabled={saving || !tradeId}>Add</Button>
        </>
      }
    >
      {open.length === 0 ? (
        <p>No open jobs yet. Create a job first.</p>
      ) : (
        <div className="form-grid">
          <Field label="Job" wide>
            <select value={jobId} onChange={(e) => loadTrades(e.target.value)}>
              {open.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          </Field>
          <Field label="Trade" wide>
            <select value={tradeId} onChange={(e) => setTradeId(e.target.value)}>
              {trades.length === 0 && <option value="">(no trades on this job)</option>}
              {trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Company"><input value={company} onChange={(e) => setCompany(e.target.value)} /></Field>
          <Field label="Contact"><input value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
          <Field label="Email" wide><input value={from?.address ?? ''} readOnly /></Field>
        </div>
      )}
    </Modal>
  )
}
/** Meeting invite (e.g. pre-bid meeting, job walk): add to calendar and RSVP to the organizer. */
function InviteCard({ message, accountId }: { message: MessageDetail; accountId: string }) {
  const { accounts, toast } = useApp()
  const [replied, setReplied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ev = message.invite!
  const me = accounts.find((a) => a.id === accountId)?.email.toLowerCase() ?? ''
  const cancelled = ev.method === 'CANCEL' || ev.status === 'CANCELLED'
  const canReply = ev.method === 'REQUEST' && !!ev.organizer?.email && ev.organizer.email.toLowerCase() !== me && !cancelled
  const when = (() => {
    if (!ev.start) return 'Time not specified'
    const s = new Date(ev.start)
    if (ev.allDay) return s.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' (all day)'
    const day = s.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const t = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    return `${day}, ${t(s)}${ev.end ? ' - ' + t(new Date(ev.end)) : ''}`
  })()

  const addToCalendar = () =>
    sys
      .openIcs(
        ev.summary,
        buildEventIcs({
          uid: ev.uid || message.messageId, summary: ev.summary, start: ev.start ?? message.date, end: ev.end ?? undefined,
          location: ev.location, description: ev.description, allDay: ev.allDay, remindMinutesBefore: ev.allDay ? [] : [60]
        })
      )
      .catch((e) => toast(e.message, 'error'))

  const rsvp = async (status: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED', label: string) => {
    setBusy(true)
    try {
      await mail.rsvp(accountId, message.key, status)
      setReplied(label)
      toast(`Sent "${label}" to ${ev.organizer?.name || ev.organizer?.email}`, 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cx('invite-card', cancelled && 'cancelled')}>
      <div className="invite-icon"><Icon name="calendar" size={22} /></div>
      <div className="grow">
        <div className="invite-title">{cancelled ? 'Canceled: ' : ''}{ev.summary}</div>
        <div className="invite-when">{when}</div>
        {ev.location && <div className="muted">{ev.location}</div>}
        {ev.organizer && <div className="muted small">Organizer: {ev.organizer.name ? `${ev.organizer.name} <${ev.organizer.email}>` : ev.organizer.email}</div>}
        <div className="invite-actions">
          {!cancelled && <Button small icon="calendar" onClick={addToCalendar}>Add to Calendar</Button>}
          {canReply && !replied && (
            <>
              <Button small kind="success" icon="check" disabled={busy} onClick={() => rsvp('ACCEPTED', 'Accepted')}>Accept</Button>
              <Button small disabled={busy} onClick={() => rsvp('TENTATIVE', 'Tentative')}>Maybe</Button>
              <Button small kind="danger" disabled={busy} onClick={() => rsvp('DECLINED', 'Declined')}>Decline</Button>
            </>
          )}
          {replied && <span className="ok-text"><Icon name="check" size={14} /> You replied: {replied}</span>}
        </div>
      </div>
    </div>
  )
}
/** "Acknowledged Addendum N" for replies like "Received addendum 2, thanks". */
function AddendumAckMenu({ match }: { match: EmailMatch }) {
  const { toast } = useApp()
  const { data } = useBidQuery(() => bid.getJob(match.jobId), [match.jobId])
  const b = data?.trades.flatMap((t) => t.bidders).find((x) => x.id === match.bidderId)
  const pending = (data?.addenda ?? []).filter((a) => b && !b.addendaAck[a.id])
  if (!pending.length) return null
  return (
    <Menu
      trigger={(open) => <Button small icon="file" onClick={open}>Acknowledged addendum</Button>}
      items={pending.map((a) => ({
        label: `Addendum ${a.number}${a.title ? ': ' + a.title : ''}`,
        icon: 'check',
        onClick: () =>
          bid
            .setAddendumAck(a.id, match.bidderId, new Date().toISOString())
            .then(() => toast(`${match.companyName} acknowledged Addendum ${a.number}`, 'success'))
            .catch((e) => toast(e.message, 'error'))
      }))}
    />
  )
}

function atHour(daysAhead: number, hour: number) {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  d.setHours(hour, 0, 0, 0)
  return d
}

function nextWeekday(day: number, hour: number) {
  const d = new Date()
  const add = ((day - d.getDay() + 7) % 7) || 7
  d.setDate(d.getDate() + add)
  d.setHours(hour, 0, 0, 0)
  return d
}

/** Earlier messages in the conversation: collapsed headers that expand to the full message. */
function ThreadHistory({ thread, accountId, folder }: { thread: MessageSummary[]; accountId: string; folder: string }) {
  const { settings, toast } = useApp()
  const [open, setOpen] = useState<Record<number, MessageDetail | 'loading'>>({})
  const toggle = async (uid: number) => {
    if (open[uid]) {
      const n = { ...open }
      delete n[uid]
      return setOpen(n)
    }
    setOpen((o) => ({ ...o, [uid]: 'loading' }))
    try {
      const d = await mail.get(accountId, folder, uid)
      setOpen((o) => ({ ...o, [uid]: d }))
    } catch (e: any) {
      toast(e.message, 'error')
      setOpen((o) => {
        const n = { ...o }
        delete n[uid]
        return n
      })
    }
  }
  return (
    <div className="thread">
      <div className="muted small">{thread.length} earlier message{thread.length === 1 ? '' : 's'} in this conversation</div>
      {[...thread].reverse().map((m) => {
        const d = open[m.uid]
        return (
          <div key={m.uid} className={cx('thread-item', d && 'open')}>
            <button className="thread-head" onClick={() => toggle(m.uid)}>
              <span className="avatar sm" style={{ background: colorFor(m.from[0]?.address ?? '') }}>{initials(displayName(m.from[0]))}</span>
              <b className={cx(!m.seen && 'unread-dot')}>{displayName(m.from[0])}</b>
              <span className="muted ellipsis grow">{m.subject}</span>
              <span className="muted small">{fmtFullDate(m.date)}</span>
            </button>
            {d === 'loading' && <div className="muted small pad">Loading...</div>}
            {d && d !== 'loading' && (
              <div className="thread-body">
                {d.attachments.length > 0 && <div className="muted small">{d.attachments.length} attachment(s): {d.attachments.map((a) => a.filename).join(', ')}</div>}
                <MessageBody html={d.html} text={d.text} allowImages={settings.reading.loadRemoteImages} simple={settings.reading.simpleView} fontSize={settings.reading.fontSize} onBlocked={() => {}} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}