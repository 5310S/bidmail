// Mac Mail connection: the script output BidMail reads back, and the recipients it hands to Mail.
// (Mail itself is only reachable on a Mac with the Mail app, so the scripts are exercised by hand.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packRecipients, parseSummaries, signatureFromSource } from '../src/main/mail/appleMail'

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

test('a Mail signature from a sent email: only the signature, with its picture inlined', async () => {
  const src = [
    'Content-Type: multipart/related; type="text/html"; boundary="b"',
    'Subject: BidMail signature preview 1',
    '',
    '--b',
    'Content-Type: text/html; charset=us-ascii',
    '',
    '<html><body><div><br></div><br><div id="AppleMailSignature"><div>Pat Smith</div><img src="cid:logo@1"><div>555-0100</div></div></body></html>',
    '--b',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Id: <logo@1>',
    'Content-Disposition: inline; filename=logo.png',
    '',
    'iVBORw0KGgo=',
    '--b--',
    ''
  ].join('\r\n')
  const html = await signatureFromSource(src, 'Pat Smith\n\n555-0100')
  assert.match(html, /^<div id="AppleMailSignature">/)
  assert.match(html, /Pat Smith/)
  assert.match(html, /src="data:image\/png;base64,iVBORw0KGgo="/)
  assert.doesNotMatch(html, /<body|cid:/)
  // Exchange strips Mail's marker from sent copies: the signature is found by its text, at the end of the email.
  const stripped = src.replace('<div><br></div><br><div id="AppleMailSignature">', '<div><blockquote>Pat, see below.<br>555-0100</blockquote></div><br><div>')
  const found = await signatureFromSource(stripped, 'Pat Smith\n\n555-0100')
  assert.match(found, /^<div><div>Pat Smith<\/div><img src="data:image\/png/)
  assert.doesNotMatch(found, /see below/)
  assert.equal(await signatureFromSource(stripped, 'Someone Else'), '')
})
