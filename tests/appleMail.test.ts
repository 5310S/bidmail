// Mac Mail connection: the script output BidMail reads back, and the recipients it hands to Mail.
// (Mail itself is only reachable on a Mac with the Mail app, so the scripts are exercised by hand.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packRecipients, parseSummaries } from '../src/main/mail/appleMail'

const US = '\x1f'
const RS = '\x1e'

test('message summaries from Mail: sender, recipients, local date, flags, attachments', () => {
  const rec = (f: string[]) => f.join(US)
  const out = [
    rec(['8855', 'Re: REQUEST FOR BID', 'Arthur Rykiel <arthur@clover.example>', 'kei@company.com', 'a@x.com,b@y.com', '2026 10 31 56229', 'true', 'false', 'true', '258154', '1a19@clover.example', '3']),
    rec(['8848', '', 'pm@gc.example', '', '', '', 'false', 'true', 'false', '900', '', '0'])
  ].join(RS)
  const [a, b] = parseSummaries(out)
  assert.equal(a.uid, 8855)
  assert.deepEqual(a.from, [{ name: 'Arthur Rykiel', address: 'arthur@clover.example' }])
  assert.deepEqual(a.cc.map((x) => x.address), ['a@x.com', 'b@y.com'])
  assert.equal(a.date, new Date(2026, 9, 31, 15, 37, 9).toISOString())
  assert.equal(a.seen, true)
  assert.equal(a.answered, true)
  assert.equal(a.hasAttachments, true)
  assert.equal(a.messageId, '<1a19@clover.example>')
  assert.equal(b.subject, '(no subject)')
  assert.equal(b.flagged, true)
  assert.equal(b.messageId, '')
  assert.deepEqual(parseSummaries(''), [])
})

test('recipients are packed as name + address pairs for the send script', () => {
  assert.equal(packRecipients('"Lisa Park" <lisa@park.example>, ray@ortiz.example'), `Lisa Park${US}lisa@park.example${RS}${US}ray@ortiz.example`)
  assert.equal(packRecipients(''), '')
})
