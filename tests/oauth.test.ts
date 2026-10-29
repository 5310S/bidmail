// Sign in with Microsoft/Google, end to end against a mock identity provider, then read and send mail
// with the access token (IMAP XOAUTH2 + SMTP XOAUTH2). Tokens are refreshed when they expire.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { SMTPServer } from 'smtp-server'
import { signIn, refresh, OAuthProvider } from '../src/main/mail/oauth'
import { MailService } from '../src/main/mail/service'
import { getAccount, saveAccount } from '../src/main/mail/accounts'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hoodiecrow = require('hoodiecrow-imap')

const IMAP_PORT = 24143
const SMTP_PORT = 24587
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let idp: http.Server
let idpUrl = ''
let imap: any
let smtp: SMTPServer
const codes = new Map<string, { challenge: string; redirect: string }>()
let issued = 0
let validToken = 'access-1'

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

before(async () => {
  idp = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (u.pathname === '/authorize') {
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(u.searchParams.get('client_id'), 'client-123')
      const code = 'code-' + Math.random().toString(36).slice(2)
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! })
      const back = new URL(u.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code)
      back.searchParams.set('state', u.searchParams.get('state')!)
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (u.pathname === '/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const f = new URLSearchParams(body)
        const reply = (status: number, o: object) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(o))
        }
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code')!)
          const ok = c && createHash('sha256').update(f.get('code_verifier')!).digest('base64url') === c.challenge && c.redirect === f.get('redirect_uri')
          if (!ok) return reply(400, { error: 'invalid_grant' })
          codes.delete(f.get('code')!)
          return reply(200, { access_token: validToken, refresh_token: 'refresh-1', expires_in: 3600, id_token: jwt({ email: 'Kei@Company.com', name: 'Kei Estimator' }) })
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (f.get('refresh_token') !== 'refresh-1' && f.get('refresh_token') !== 'refresh-2') return reply(400, { error: 'invalid_grant' })
          issued++
          validToken = 'access-' + (issued + 1)
          imap.users['kei@company.com'].xoauth2.accessToken = validToken
          return reply(200, { access_token: validToken, refresh_token: 'refresh-2', expires_in: 3600 })
        }
        reply(400, { error: 'unsupported_grant_type' })
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()))
  idpUrl = `http://127.0.0.1:${(idp.address() as any).port}`

  imap = hoodiecrow({
    plugins: ['SASL-IR', 'XOAUTH2', 'IDLE', 'SPECIAL-USE', 'UIDPLUS', 'MOVE', 'ID'],
    users: { 'kei@company.com': { password: 'not-used', xoauth2: { accessToken: 'access-1' } } },
    storage: { INBOX: { messages: [{ raw: 'From: pm@gc.com\r\nTo: kei@company.com\r\nSubject: Hello via OAuth\r\n\r\nhi' }] }, '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' } } } }
  })
  await new Promise<void>((r) => imap.listen(IMAP_PORT, '127.0.0.1', () => r()))
  smtp = new SMTPServer({
    authMethods: ['XOAUTH2'],
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _s, cb) {
      if (auth.method === 'XOAUTH2' && auth.username === 'kei@company.com' && auth.accessToken === validToken) return cb(null, { user: auth.username })
      cb(null, { data: { status: '401', schemes: 'bearer' } } as any)
    },
    onData(stream, _s, cb) {
      const chunks: Buffer[] = []
      stream.on('data', (c) => chunks.push(c))
      stream.on('end', () => {
        imap.appendMessage('INBOX', [], false, Buffer.concat(chunks).toString('binary'))
        cb()
      })
    }
  })
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, '127.0.0.1', () => r()))
})

after(async () => {
  await new Promise((r) => smtp.close(() => r(null)))
  await new Promise((r) => imap.close(r))
  await new Promise((r) => idp.close(() => r(null)))
})

const provider = (): OAuthProvider => ({
  id: 'microsoft', label: 'Microsoft', authUrl: idpUrl + '/authorize', tokenUrl: idpUrl + '/token',
  scopes: ['openid', 'offline_access', 'mail'], clientId: 'client-123', redirectHost: '127.0.0.1',
  imap: { host: '127.0.0.1', port: IMAP_PORT, secure: false }, smtp: { host: '127.0.0.1', port: SMTP_PORT, secure: false }
})

/** Plays the browser: follows the provider redirect back to BidMail's loopback address. */
async function browser(url: string) {
  const r = await fetch(url, { redirect: 'manual' })
  const loc = r.headers.get('location')!
  assert.match(loc, /^http:\/\/127\.0\.0\.1:\d+\/callback\?/)
  const page = await (await fetch(loc)).text()
  assert.match(page, /You are signed in/)
}

test('browser sign-in with PKCE returns the email and a long-term refresh token', async () => {
  const r = await signIn(provider(), browser)
  assert.equal(r.email, 'kei@company.com')
  assert.equal(r.name, 'Kei Estimator')
  assert.equal(r.refreshToken, 'refresh-1')
  assert.equal(r.accessToken, 'access-1')
  await assert.rejects(signIn({ ...provider(), clientId: '' }, browser), /client ID/)
  await assert.rejects(refresh(provider(), 'revoked'), /expired or was revoked/)
})

test('a signed-in account reads and sends mail with tokens, refreshing them when needed', async () => {
  const p = provider()
  const svc = new MailService()
  svc.oauthProvider = () => p
  const account = saveAccount({
    account: {
      id: '', displayName: 'Kei Estimator', email: 'kei@company.com', signature: '', color: '#2f6fdb',
      imap: { ...p.imap, user: 'kei@company.com' }, smtp: { ...p.smtp, user: 'kei@company.com' },
      saveSentCopy: false, allowInvalidCerts: false, authType: 'oauth', oauthProvider: 'microsoft'
    },
    password: 'refresh-1'
  })
  try {
    // No access token cached yet: the service refreshes, rotates the refresh token, and signs in with XOAUTH2.
    const folders = await svc.listFolders(account.id)
    assert.ok(folders.some((f) => f.specialUse === '\\Inbox'))
    assert.equal(getAccount(account.id)!.password, 'refresh-2', 'the new refresh token is saved')
    const list = await svc.listMessages(account.id, 'INBOX')
    assert.equal(list.messages[0].subject, 'Hello via OAuth')

    await svc.send({ accountId: account.id, to: 'kei@company.com', cc: '', bcc: '', subject: 'Sent with OAuth', html: '<p>ok</p>', attachments: [] })
    await sleep(200)
    const after = await svc.listMessages(account.id, 'INBOX')
    assert.ok(after.messages.some((m) => m.subject === 'Sent with OAuth'))

    // An expired session ends cleanly with a "sign in again" message.
    saveAccount({ account: getAccount(account.id)!.account, password: 'revoked' })
    const fresh = new MailService()
    fresh.oauthProvider = () => p
    await assert.rejects(fresh.listFolders(account.id), /Sign in again|expired or was revoked/)
    await fresh.disconnectAll()
  } finally {
    await svc.disconnectAll()
  }
})