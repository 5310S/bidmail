// Snooze, mail rules and conversation grouping.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { MailService } from '../src/main/mail/service'
import { saveAccount } from '../src/main/mail/accounts'
import { SnoozeService } from '../src/main/mail/snooze'
import { RulesRunner } from '../src/main/mail/rulesRunner'
import { MailRule, planRules, ruleMatches } from '../src/shared/rules'
import { normalizeSubject, threadMessages } from '../src/shared/threads'
import type { MailAccount, MessageSummary } from '../src/shared/ipc'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hoodiecrow = require('hoodiecrow-imap')

const PORT = 25143
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail2-'))
const raw = (from: string, subject: string, id: string, extra = '') =>
  ({ raw: `From: ${from}\r\nTo: kei@test.local\r\nSubject: ${subject}\r\nMessage-ID: <${id}>\r\n${extra}Date: Mon, 26 Oct 2026 09:00:00 -0500\r\n\r\nbody`, internaldate: '26-Oct-2026 09:00:00 -0500' })
let imap: any
let svc: MailService
let account: MailAccount

before(async () => {
  imap = hoodiecrow({
    plugins: ['IDLE', 'SPECIAL-USE', 'MOVE', 'UIDPLUS', 'ID', 'UNSELECT'],
    users: { kei: { password: 'pw' } },
    storage: {
      INBOX: {
        messages: [
          raw('"Plan Room" <noreply@planroom.example>', 'Addendum 2 posted', 'pr1@x'),
          raw('"Pat Turner" <pat@turnergc.com>', 'Riverside schedule', 'gc1@x'),
          raw('"Lisa" <lisa@parkplumbing.com>', 'Quote attached', 'sub1@x')
        ]
      },
      '': { separator: '/', folders: { 'Plan Room': {}, Trash: { 'special-use': '\\Trash' } } }
    }
  })
  await new Promise<void>((r) => imap.listen(PORT, '127.0.0.1', () => r()))
  account = saveAccount({
    account: {
      id: '', displayName: 'Kei', email: 'kei@test.local', signature: '', color: '#000',
      imap: { host: '127.0.0.1', port: PORT, secure: false, user: 'kei' }, smtp: { host: '127.0.0.1', port: 1, secure: false, user: 'kei' },
      saveSentCopy: false, allowInvalidCerts: true
    },
    password: 'pw'
  })
  svc = new MailService()
})

after(async () => {
  await svc.disconnectAll()
  await new Promise((r) => imap.close(r))
})

test('rules: conditions, combined actions and moving mail to a folder', async () => {
  const rules: MailRule[] = [
    { id: 'r1', name: 'Plan room notices', enabled: true, accountId: account.id, match: 'any',
      conditions: [{ field: 'from', op: 'ends_with', value: '@planroom.example' }, { field: 'subject', op: 'contains', value: 'bid board' }],
      actions: { moveTo: 'Plan Room', markRead: true } },
    { id: 'r2', name: 'Flag the GC', enabled: true, accountId: '*', match: 'all',
      conditions: [{ field: 'from', op: 'contains', value: 'turnergc.com' }, { field: 'subject', op: 'not_contains', value: 'newsletter' }],
      actions: { flag: true } },
    { id: 'r3', name: 'Disabled', enabled: false, accountId: '*', match: 'all', conditions: [{ field: 'any', op: 'contains', value: 'quote' }], actions: { flag: true } }
  ]
  const list = await svc.listMessages(account.id, 'INBOX')
  const plan = planRules(rules, account.id, list.messages)
  assert.equal(plan.length, 2)
  const pr = plan.find((p) => p.moveTo)!
  assert.deepEqual([pr.markRead, pr.silent], [true, true], 'filed-away mail does not notify')
  assert.equal(ruleMatches(rules[2], list.messages[0]), false, 'disabled rules never match')

  const runner = new RulesRunner(svc, path.join(dir, 'rules.json'))
  runner.save(rules)
  assert.equal(runner.list().length, 3)
  assert.equal(await runner.runOnInbox(account.id), 2)
  const inbox = await svc.listMessages(account.id, 'INBOX')
  assert.deepEqual(inbox.messages.map((m) => m.subject).sort(), ['Quote attached', 'Riverside schedule'])
  assert.equal(inbox.messages.find((m) => m.subject === 'Riverside schedule')!.flagged, true)
  const filed = await svc.listMessages(account.id, 'Plan Room')
  assert.equal(filed.messages[0].subject, 'Addendum 2 posted')
  assert.equal(filed.messages[0].seen, true)
})

test('snooze: hides a message until its time, then returns it unread', async () => {
  const snoozer = new SnoozeService(svc, path.join(dir, 'snoozes.json'))
  const woke: any[] = []
  snoozer.on('woke', (w) => woke.push(w))
  const inbox = await svc.listMessages(account.id, 'INBOX')
  const target = inbox.messages.find((m) => m.subject === 'Quote attached')!
  await assert.rejects(snoozer.snooze(account.id, 'INBOX', target.uid, new Date(Date.now() - 1000).toISOString()), /future/)

  const s = await snoozer.snooze(account.id, 'INBOX', target.uid, new Date(Date.now() + 800).toISOString())
  assert.equal(s.subject, 'Quote attached')
  assert.equal(s.returnFolder, 'INBOX')
  assert.ok(!(await svc.listMessages(account.id, 'INBOX')).messages.some((m) => m.subject === 'Quote attached'), 'gone from the inbox')
  assert.equal((await svc.listMessages(account.id, 'Snoozed')).messages.length, 1, 'kept in a Snoozed folder on the server')

  await snoozer.tick()
  assert.equal(woke.length, 0, 'not due yet')
  await new Promise((r) => setTimeout(r, 900))
  await snoozer.tick()
  assert.equal(woke.length, 1)
  const back = (await svc.listMessages(account.id, 'INBOX')).messages.find((m) => m.subject === 'Quote attached')!
  assert.ok(back, 'back in the inbox')
  assert.equal(back.seen, false, 'and unread, so it gets attention')
  assert.equal(snoozer.list().length, 0)
  assert.equal((await svc.listMessages(account.id, 'Snoozed')).messages.length, 0)

  // Wake early ("unsnooze") also works.
  const s2 = await snoozer.snooze(account.id, 'INBOX', back.uid, new Date(Date.now() + 86400000).toISOString())
  await snoozer.wake(s2.id)
  assert.ok((await svc.listMessages(account.id, 'INBOX')).messages.some((m) => m.subject === 'Quote attached'))
})

const msg = (uid: number, subject: string, o: Partial<MessageSummary> = {}): MessageSummary => ({
  uid, subject, from: [{ name: '', address: 'a@x.com' }], to: [], cc: [], date: new Date(2026, 9, 20 + uid).toISOString(),
  seen: true, flagged: false, answered: false, draft: false, hasAttachments: false, size: 1, messageId: `<m${uid}@x>`, inReplyTo: '', ...o
})

test('conversations group replies by headers and by subject', () => {
  assert.equal(normalizeSubject('RE: Fwd: re:  Electrical Pricing'), 'electrical pricing')
  const convs = threadMessages([
    msg(1, 'Electrical pricing - Riverside'),
    msg(2, 'RE: Electrical pricing - Riverside', { inReplyTo: '<m1@x>', seen: false }),
    msg(3, 'Totally different subject', { inReplyTo: '<m2@x>' }), // reply chain wins over subject
    msg(4, 'Fwd: Electrical pricing - Riverside'), // same subject, no headers
    msg(5, 'Quote'), // generic subjects never group
    msg(6, 'Quote', { hasAttachments: true })
  ])
  assert.equal(convs.length, 3)
  const big = convs.find((c) => c.messages.length === 4)!
  assert.deepEqual(big.messages.map((m) => m.uid), [4, 3, 2, 1], 'newest first')
  assert.equal(big.unread, 1)
  assert.equal(convs[0].latest.uid, 6, 'conversations sorted by latest message')
})