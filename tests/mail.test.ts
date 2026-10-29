// End-to-end mail test against a local IMAP server (hoodiecrow) and SMTP server that delivers to its INBOX.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MailService } from '../src/main/mail/service'
import { saveAccount } from '../src/main/mail/accounts'
import { BidBackend } from '../src/main/bidBackend'
import { BulkSender } from '../src/main/bulk'
import type { BulkProgress, MailAccount } from '../src/shared/ipc'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hoodiecrow = require('hoodiecrow-imap')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startSMTPServer } = require('hoodiecrow-imap/lib/hoodiecrowSMTPServer')

const IMAP_PORT = 21143
const SMTP_PORT = 21587
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const seedMessage = [
  'From: "Mike Jones" <mike@abc-electric.com>',
  'To: estimator@test.local',
  'Subject: Riverside MOB - Electrical proposal',
  'Date: Tue, 27 Oct 2026 10:15:00 -0500',
  'Message-ID: <seed-1@abc-electric.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: multipart/related; boundary="b2"',
  '',
  '--b2',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Attached is our price of <b>$125,000</b>.</p><img src="cid:logo@abc"><img src="https://tracker.example/pixel.gif"><script>alert(1)</script>',
  '--b2',
  'Content-Type: image/png',
  'Content-ID: <logo@abc>',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  '--b2--',
  '--b1',
  'Content-Type: application/pdf; name="ABC Proposal.pdf"',
  'Content-Disposition: attachment; filename="ABC Proposal.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake proposal').toString('base64'),
  '--b1--',
  ''
].join('\r\n')

const inviteMessage = [
  'From: "Pat Turner" <pat@turnergc.com>',
  'To: estimator@test.local',
  'Subject: Invitation: Riverside MOB - Pre-Bid Meeting',
  'Date: Wed, 28 Oct 2026 08:00:00 -0500',
  'Message-ID: <invite-1@turnergc.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Pre-bid meeting at the site.',
  '--alt',
  'Content-Type: text/calendar; charset=utf-8; method=REQUEST',
  '',
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:prebid-777@turnergc.com',
  'SEQUENCE:0',
  'ORGANIZER;CN=Pat Turner:mailto:pat@turnergc.com',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:estimator@test.local',
  'SUMMARY:Riverside MOB - Pre-Bid Meeting',
  'LOCATION:Site trailer',
  'DTSTART;TZID=Central Standard Time:20261103T100000',
  'DTEND;TZID=Central Standard Time:20261103T110000',
  'END:VEVENT',
  'END:VCALENDAR',
  '--alt--',
  ''
].join('\r\n')

let imap: any
let smtp: any
let svc: MailService
let account: MailAccount

before(async () => {
  imap = hoodiecrow({
    plugins: ['IDLE', 'SPECIAL-USE', 'MOVE', 'UIDPLUS', 'LIST-STATUS', 'ENABLE', 'ID', 'UNSELECT', 'NAMESPACE'],
    users: { estimator: { password: 'pw' } },
    storage: {
      INBOX: { messages: [{ raw: seedMessage, internaldate: '27-Oct-2026 10:15:00 -0500' }] },
      '': {
        separator: '/',
        folders: {
          Sent: { 'special-use': '\\Sent' },
          Drafts: { 'special-use': '\\Drafts' },
          Trash: { 'special-use': '\\Trash' },
          Archive: { 'special-use': '\\Archive' },
          Bids: { messages: [{ raw: inviteMessage, internaldate: '28-Oct-2026 08:00:00 -0500' }] }
        }
      }
    }
  })
  const _append = imap.appendMessage.bind(imap)
  imap.appendMessage = (...a: any[]) => {
    try {
      return _append(...a)
    } catch (e: any) {
      console.log('DEBUG APPEND ERROR', e.message, String(a[3]).slice(0, 2000))
      throw e
    }
  }
  await new Promise<void>((r) => imap.listen(IMAP_PORT, '127.0.0.1', () => r()))
  smtp = await new Promise((r) => {
    const s = startSMTPServer(SMTP_PORT, imap, () => r(s))
  })
  account = saveAccount({
    account: {
      id: '', displayName: 'Kei Estimator', email: 'estimator@test.local', signature: '<p>-- Kei</p>', color: '#2f6fdb',
      imap: { host: '127.0.0.1', port: IMAP_PORT, secure: false, user: 'estimator' },
      smtp: { host: '127.0.0.1', port: SMTP_PORT, secure: false, user: 'estimator' },
      saveSentCopy: true, allowInvalidCerts: true
    },
    password: 'pw'
  })
  svc = new MailService()
})

after(async () => {
  await svc.disconnectAll()
  await new Promise((r) => smtp.close(r))
  await new Promise((r) => imap.close(r))
})

test('folders are listed with Inbox first and special folders recognized', async () => {
  const folders = await svc.listFolders(account.id)
  assert.equal(folders[0].specialUse, '\\Inbox')
  const uses = folders.map((f) => f.specialUse)
  for (const u of ['\\Sent', '\\Drafts', '\\Trash', '\\Archive']) assert.ok(uses.includes(u), u)
  assert.ok(folders.some((f) => f.name === 'Bids'))
  assert.equal(folders[0].unseen, 1)
})

test('reading a message: html, inline images, attachments, blocked trackers flagged', async () => {
  const list = await svc.listMessages(account.id, 'INBOX')
  assert.equal(list.messages.length, 1)
  const m = list.messages[0]
  assert.equal(m.subject, 'Riverside MOB - Electrical proposal')
  assert.equal(m.from[0].address, 'mike@abc-electric.com')
  assert.equal(m.hasAttachments, true)
  assert.equal(m.seen, false)

  const d = await svc.getMessage(account.id, 'INBOX', m.uid)
  assert.match(d.html, /\$125,000/)
  assert.match(d.html, /data:image\/png;base64,/, 'cid image inlined')
  assert.equal(d.attachments.length, 1, 'inline image is not listed as an attachment')
  assert.equal(d.attachments[0].filename, 'ABC Proposal.pdf')
  assert.equal(d.hasRemoteImages, true)
  assert.equal(d.seen, true)

  const out = await svc.writeAttachment(d.key, d.attachments[0].id, fs.mkdtempSync(path.join(os.tmpdir(), 'att-')))
  assert.equal(fs.readFileSync(out, 'utf8'), '%PDF-1.4 fake proposal')

  const again = await svc.listMessages(account.id, 'INBOX')
  assert.equal(again.messages[0].seen, true, 'opening marks as read on the server')
})

test('send with attachment arrives, Sent copy saved, reply flags original answered', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'send-')), 'Scope Sheet.txt')
  fs.writeFileSync(file, 'Electrical scope')
  const inbox = await svc.listMessages(account.id, 'INBOX')
  const orig = await svc.getMessage(account.id, 'INBOX', inbox.messages[0].uid)
  await svc.send({
    accountId: account.id, to: 'Kei <estimator@test.local>', cc: '', bcc: '', subject: 'Re: ' + orig.subject,
    html: '<p>Thanks Mike, got it.</p>', attachments: [{ filename: 'Scope Sheet.txt', path: file }],
    inReplyTo: orig.messageId, references: [orig.messageId], answered: { path: 'INBOX', uid: orig.uid }
  })
  await sleep(300)
  const after = await svc.listMessages(account.id, 'INBOX')
  assert.equal(after.messages.length, 2)
  const reply = after.messages.find((x) => x.subject.startsWith('Re:'))!
  assert.ok(reply.hasAttachments)
  const rd = await svc.getMessage(account.id, 'INBOX', reply.uid)
  assert.equal(rd.attachments[0].filename, 'Scope Sheet.txt')
  assert.match(rd.text, /Thanks Mike/, 'plain-text alternative generated')
  assert.ok(rd.references.includes('<seed-1@abc-electric.com>'))

  const sent = await svc.listMessages(account.id, 'Sent')
  assert.equal(sent.messages.length, 1)
  const o = (await svc.listMessages(account.id, 'INBOX')).messages.find((x) => x.uid === orig.uid)!
  assert.equal(o.answered, true)
})

test('flags, search, drafts, archive and delete', async () => {
  let list = await svc.listMessages(account.id, 'INBOX')
  const first = list.messages.find((x) => x.subject.startsWith('Riverside'))!
  await svc.setFlags(account.id, 'INBOX', [first.uid], { flagged: true, seen: false })
  list = await svc.listMessages(account.id, 'INBOX')
  const f2 = list.messages.find((x) => x.uid === first.uid)!
  assert.equal(f2.flagged, true)
  assert.equal(f2.seen, false)

  const found = await svc.search(account.id, 'INBOX', 'proposal')
  assert.ok(found.messages.some((x) => x.uid === first.uid))

  const draft = await svc.saveDraft({ accountId: account.id, to: 'x@y.com', cc: '', bcc: '', subject: 'Draft bid', html: '<p>wip</p>', attachments: [] })
  assert.ok(draft && draft.uid)
  let drafts = await svc.listMessages(account.id, 'Drafts')
  assert.equal(drafts.messages.length, 1)
  assert.equal(drafts.messages[0].draft, true)
  const d2 = await svc.saveDraft({ accountId: account.id, to: 'x@y.com', cc: '', bcc: '', subject: 'Draft bid v2', html: '<p>wip 2</p>', attachments: [], draft: draft! })
  drafts = await svc.listMessages(account.id, 'Drafts')
  assert.equal(drafts.messages.length, 1, 'saving again replaces the old draft')
  assert.equal(drafts.messages[0].subject, 'Draft bid v2')
  await svc.send({ accountId: account.id, to: 'estimator@test.local', cc: '', bcc: '', subject: 'Draft bid v2', html: '<p>final</p>', attachments: [], draft: d2! })
  drafts = await svc.listMessages(account.id, 'Drafts')
  assert.equal(drafts.messages.length, 0, 'sending a draft removes it')

  await svc.archive(account.id, 'INBOX', [first.uid])
  assert.equal((await svc.listMessages(account.id, 'Archive')).messages.length, 1)
  const inbox = await svc.listMessages(account.id, 'INBOX')
  await svc.remove(account.id, 'INBOX', [inbox.messages[0].uid])
  const trash = await svc.listMessages(account.id, 'Trash')
  assert.equal(trash.messages.length, 1)
  await svc.remove(account.id, 'Trash', [trash.messages[0].uid])
  assert.equal((await svc.listMessages(account.id, 'Trash')).messages.length, 0, 'deleting from Trash removes permanently')
})

test('meeting invites are recognized and RSVP replies reach the organizer', async () => {
  const bids = await svc.listMessages(account.id, 'Bids')
  const inv = await svc.getMessage(account.id, 'Bids', bids.messages[0].uid)
  assert.ok(inv.invite, 'invite parsed')
  assert.equal(inv.invite!.summary, 'Riverside MOB - Pre-Bid Meeting')
  assert.equal(inv.invite!.method, 'REQUEST')
  assert.equal(inv.invite!.start, '2026-11-03T16:00:00.000Z')
  assert.equal(inv.invite!.organizer?.email, 'pat@turnergc.com')
  assert.equal(inv.attachments.length, 0, 'the calendar part is shown as an invite card, not a file')

  const before = (await svc.listMessages(account.id, 'INBOX')).total
  await svc.respondToInvite(account.id, inv.key, 'ACCEPTED')
  await sleep(200)
  // INBOX is still open on the same connection here: the list must still pick up the new message.
  const inbox = await svc.listMessages(account.id, 'INBOX')
  assert.equal(inbox.total, before + 1)
  const reply = inbox.messages.find((x) => x.subject === 'Accepted: Riverside MOB - Pre-Bid Meeting')!
  assert.ok(reply, 'reply delivered (the test SMTP server delivers everything to this inbox)')
  const rd = await svc.getMessage(account.id, 'INBOX', reply.uid)
  assert.equal(rd.invite?.method, 'REPLY')
  assert.equal(rd.invite?.uid, 'prebid-777@turnergc.com')
  assert.equal(rd.invite?.attendees[0].partstat, 'ACCEPTED')
  assert.equal(rd.invite?.attendees[0].email, 'estimator@test.local')
})

test('actions on several messages at once', async () => {
  const inbox = await svc.listMessages(account.id, 'INBOX')
  const two = inbox.messages.slice(0, 2).map((m) => m.uid)
  assert.equal(two.length, 2)
  await svc.setFlags(account.id, 'INBOX', two, { flagged: true, seen: false })
  let after = await svc.listMessages(account.id, 'INBOX')
  for (const uid of two) {
    const m = after.messages.find((x) => x.uid === uid)!
    assert.equal(m.flagged, true)
    assert.equal(m.seen, false)
  }
  const bidsBefore = (await svc.listMessages(account.id, 'Bids')).total
  await svc.move(account.id, 'INBOX', two, 'Bids')
  after = await svc.listMessages(account.id, 'INBOX')
  assert.ok(two.every((uid) => !after.messages.some((x) => x.uid === uid)), 'both left the inbox')
  assert.equal((await svc.listMessages(account.id, 'Bids')).total, bidsBefore + 2)
})

test('new mail watcher fires on arrival (IMAP IDLE)', async () => {
  const got = new Promise<any>((resolve) => svc.once('newMail', resolve))
  await svc.startWatcher(account.id)
  await sleep(300)
  await svc.send({ accountId: account.id, to: 'estimator@test.local', cc: '', bcc: '', subject: 'Price: Plumbing', html: '<p>$88,000</p>', attachments: [] })
  const ev = await Promise.race([got, sleep(8000).then(() => null)])
  assert.ok(ev, 'newMail event received')
  assert.equal(ev.messages[0].subject, 'Price: Plumbing')
})

test('bulk bid invitations: one personalized email per company + status stamped', async () => {
  const backend = new BidBackend(() => 'Kei', () => {}, () => {})
  await backend.configure({ mode: 'local', url: '', key: '', port: 0 })
  const job = await backend.call('createJob', [{ name: 'Riverside MOB', drawingsLink: 'https://files.example/drawings', specsLink: 'https://files.example/specs', bidDue: '2026-11-04T19:00:00.000Z' }])
  const trade = await backend.call('addTrade', [job.id, { name: 'Electrical' }])
  const b1 = await backend.call('addBidder', [trade.id, { companyName: 'ABC Electric', contactName: 'Mike Jones', email: 'estimator@test.local' }])
  const b2 = await backend.call('addBidder', [trade.id, { companyName: 'Volt Bros', contactName: '', email: 'estimator@test.local' }])
  const b3 = await backend.call('addBidder', [trade.id, { companyName: 'No Email Co' }])

  const before = (await svc.listMessages(account.id, 'INBOX')).total
  const progress: BulkProgress[] = []
  const done = new Promise<void>((resolve) => {
    const bulk = new BulkSender(svc, backend, (p) => {
      progress.push(p)
      if (p.done) resolve()
    })
    bulk.start({
      accountId: account.id, jobId: job.id, bidderIds: [b1.id, b2.id, b3.id], attachments: [], markAs: 'drawings_sent',
      subject: 'Invitation to Bid: {{job_name}} - {{trade}}',
      body: '<p>Hi {{first_name|there}},</p><p>{{company}}: drawings {{drawings_link}}, specs {{specs_link}}. Due {{bid_due}}.</p>'
    })
  })
  await Promise.race([done, sleep(20000)])
  const final = Object.fromEntries(progress.map((p) => [p.bidderId, p.state]))
  assert.equal(final[b1.id], 'sent')
  assert.equal(final[b2.id], 'sent')
  assert.equal(final[b3.id], 'skipped')

  await sleep(300)
  const inbox = await svc.listMessages(account.id, 'INBOX')
  assert.equal(inbox.total, before + 2)
  const invites = inbox.messages.filter((m) => m.subject === 'Invitation to Bid: Riverside MOB - Electrical')
  assert.equal(invites.length, 2)
  const bodies = await Promise.all(invites.map((m) => svc.getMessage(account.id, 'INBOX', m.uid)))
  const texts = bodies.map((b) => b.html)
  assert.ok(texts.some((t) => /Hi Mike,/.test(t) && /ABC Electric/.test(t)))
  assert.ok(texts.some((t) => /Hi there,/.test(t) && /Volt Bros/.test(t)))
  assert.ok(texts.every((t) => /href="https:\/\/files.example\/drawings"/.test(t) && /-- Kei/.test(t)))
  assert.ok(bodies.every((b) => b.to.length === 1), 'each company gets its own email (no shared To list)')

  const d = await backend.call('getJob', [job.id])
  const st = Object.fromEntries(d.trades[0].bidders.map((b: any) => [b.companyName, b.drawingsSentAt]))
  assert.ok(st['ABC Electric'] && st['Volt Bros'], 'drawings sent stamped with date/time')
  assert.equal(st['No Email Co'], null)
  await backend.shutdown()
})
test('offline: folders, message list and downloaded messages open with no connection', async () => {
  const online = await svc.listMessages(account.id, 'INBOX')
  await sleep(2000) // let the background download of recent messages finish
  const target = online.messages[0]

  // Same account, but the mail server is unreachable (nothing listens on port 1).
  saveAccount({ account: { ...account, imap: { ...account.imap, port: 1 }, smtp: { ...account.smtp, port: 1 } } })
  const offlineSvc = new MailService()
  try {
    const folders = await offlineSvc.listFolders(account.id)
    assert.ok(folders.some((f) => f.specialUse === '\\Inbox'), 'saved folder list')
    const list = await offlineSvc.listMessages(account.id, 'INBOX')
    assert.ok(list.offline, 'marked as offline')
    assert.equal(list.messages.length, online.messages.length)
    const d = await offlineSvc.getMessage(account.id, 'INBOX', target.uid)
    assert.equal(d.subject, target.subject)
    assert.equal(d.fromCache, true)
    await assert.rejects(offlineSvc.listMessages(account.id, 'INBOX', 60), 'older pages need the server')
  } finally {
    await offlineSvc.disconnectAll()
    saveAccount({ account })
  }
})