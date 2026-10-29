// Team server v2: HTTPS with a pinned self-signed certificate, per-user logins, admin-only user
// management, change log with real names, update hosting, and sign-in throttling.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { BidStore } from '../src/shared/store'
import { startTeamServer, RunningTeamServer } from '../src/shared/teamServer'
import { loadOrCreateCert } from '../src/shared/cert'
import { BidBackend } from '../src/main/bidBackend'
import { fetchCertificate, request } from '../src/main/net'
import { publishInstaller } from '../src/main/updatesFeed'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team2-'))
const updatesDir = path.join(dir, 'updates')
let store: BidStore
let srv: RunningTeamServer
let url: string
let pin: string
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const team = (o: object) => ({ mode: 'remote' as const, url, key: '', port: 0, https: true, username: '', token: '', certPem: pin, ...o })

before(async () => {
  store = new BidStore(path.join(dir, 'team.db'))
  const tls = await loadOrCreateCert(path.join(dir, 'cert.json'))
  srv = await startTeamServer({ store, port: 0, key: 'setup-key-1', host: '127.0.0.1', tls: { key: tls.key, cert: tls.cert }, updatesDir })
  url = `https://127.0.0.1:${srv.port}`
  const again = await loadOrCreateCert(path.join(dir, 'cert.json'))
  assert.equal(again.fingerprint, tls.fingerprint, 'the certificate is saved and reused')
})

after(async () => {
  await srv.close()
  store.close()
})

test('HTTPS: unknown self-signed certificate is refused until pinned', async () => {
  await assert.rejects(BidBackend.health(url), /certificate/i)
  const cert = await fetchCertificate(url)
  assert.equal(cert.trusted, false)
  assert.match(cert.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  pin = cert.pem
  const h = await BidBackend.health(url, pin)
  assert.deepEqual([h.needsSetup, h.https], [true, true])
})

test('first admin is created with the setup key, then logins are required', async () => {
  await assert.rejects(BidBackend.setup(url, 'wrong', 'kei', 'admin password', 'Kei Estimator', pin), /setup key is wrong/)
  const s = await BidBackend.setup(url, 'setup-key-1', 'kei', 'admin password', 'Kei Estimator', pin)
  assert.equal(s.user.role, 'admin')
  await assert.rejects(BidBackend.setup(url, 'setup-key-1', 'kei2', 'admin password', 'X', pin), /already set up/)
  const legacy = await request(url + '/rpc', { method: 'POST', body: { method: 'listJobs', args: [] }, headers: { Authorization: 'Bearer setup-key-1' }, pinPem: pin })
  assert.equal(legacy.status, 401, 'the shared key stops working once accounts exist')

  const statuses: any[] = []
  const admin = new BidBackend(() => 'ignored', () => {}, (st) => statuses.push(st))
  await admin.configure(team({ username: 'kei', token: s.token }))
  for (let i = 0; i < 50 && !admin.getStatus().connected; i++) await sleep(50)
  assert.equal(admin.getStatus().connected, true, admin.getStatus().error)
  assert.equal(admin.getStatus().user?.displayName, 'Kei Estimator')

  const job = await admin.call('createJob', [{ name: 'Secure Job' }])
  assert.equal(job.updatedBy, 'Kei Estimator', 'the server names the signed-in user, not what the app claims')

  // Admin adds a teammate; the teammate can work but cannot manage users.
  await admin.createUser({ username: 'pat', displayName: 'Pat Smith', password: 'pat password 1' })
  const users = await admin.listUsers()
  assert.deepEqual(users.map((u) => u.username), ['kei', 'pat'])
  const p = await BidBackend.login(url, 'PAT', 'pat password 1', pin)
  const member = new BidBackend(() => '', () => {}, () => {})
  await member.configure(team({ username: 'pat', token: p.token }))
  await member.call('addTrade', [job.id, { name: 'Electrical' }])
  await assert.rejects(member.listUsers(), /Only admins/)
  const log = store.listAudit(job.id)
  assert.deepEqual(log.map((x) => x.userName), ['Pat Smith', 'Kei Estimator'])

  // Deactivating the teammate ends their session immediately.
  await admin.updateUser(users[1].id, { active: false })
  await assert.rejects(member.call('listJobs', []), /Sign in/)
  assert.equal(member.getStatus().needsLogin, true)

  // Changing your own password keeps you signed in with a new session.
  await admin.changePassword('admin password', 'new admin password')
  await assert.rejects(BidBackend.login(url, 'kei', 'admin password', pin), /Wrong username or password/)
  assert.ok((await BidBackend.login(url, 'kei', 'new admin password', pin)).token)

  await member.shutdown()
  await admin.shutdown()
})

test('a different server certificate is refused (pin mismatch)', async () => {
  const otherStore = new BidStore(path.join(dir, 'other.db'))
  const otherTls = await loadOrCreateCert(path.join(dir, 'other-cert.json'))
  const other = await startTeamServer({ store: otherStore, port: 0, key: 'k', host: '127.0.0.1', tls: { key: otherTls.key, cert: otherTls.cert } })
  try {
    await assert.rejects(BidBackend.health(`https://127.0.0.1:${other.port}`, pin), /certificate/i)
  } finally {
    await other.close()
    otherStore.close()
  }
})

test('update files are served to teammates; nothing else is reachable', async () => {
  const fakeInstaller = path.join(dir, 'BidMail Setup 1.0.1.exe')
  fs.writeFileSync(fakeInstaller, 'installer bytes')
  const yml = publishInstaller(fakeInstaller, '1.0.1', updatesDir)
  const text = fs.readFileSync(yml, 'utf8')
  assert.match(text, /^version: 1\.0\.1$/m)
  assert.match(text, /url: BidMail-Setup-1\.0\.1\.exe/, 'spaces removed from the file name')
  assert.throws(() => publishInstaller(fakeInstaller, 'latest', updatesDir), /version number/)
  const r = await request(url + '/updates/latest.yml', { pinPem: pin })
  assert.equal(r.status, 200)
  assert.match(String(r.body), /sha512:/)
  const exe = await request(url + '/updates/BidMail-Setup-1.0.1.exe', { pinPem: pin })
  assert.equal(exe.body, 'installer bytes')
  const sneaky = await request(url + '/updates/..%2Fteam.db', { pinPem: pin })
  assert.equal(sneaky.status, 400)
})

test('repeated wrong passwords are slowed down', async () => {
  let last = 0
  for (let i = 0; i < 11; i++) {
    const r = await request(url + '/auth/login', { method: 'POST', body: { username: 'kei', password: 'guess' + i }, pinPem: pin })
    last = r.status
  }
  assert.equal(last, 429)
})