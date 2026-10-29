// Two "computers": one hosts the team data, the other connects remotely and sees changes live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BidBackend } from '../src/main/bidBackend'
import type { TeamStatus } from '../src/shared/ipc'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('host and remote backends share data with live updates', async () => {
  const backends: BidBackend[] = []
  try {
  const host = new BidBackend(() => 'Host User', () => {}, () => {})
  backends.push(host)
  await host.configure({ mode: 'host', url: '', key: 'team-key-123', port: 0, https: false, username: '', token: '', certPem: '' })
  const hostStatus = host.getStatus()
  assert.equal(hostStatus.connected, true, hostStatus.error)
  const port = Number(hostStatus.addresses[0].split(':').pop())
  assert.ok(port > 0)

  let changes = 0
  const statuses: TeamStatus[] = []
  const remote = new BidBackend(() => 'Remote User', () => changes++, (s) => statuses.push(s))
  backends.push(remote)
  await remote.configure({ mode: 'remote', url: `127.0.0.1:${port}`, key: 'team-key-123', port: 0, https: false, username: '', token: '', certPem: '' })
  for (let i = 0; i < 50 && !remote.getStatus().connected; i++) await sleep(50)
  assert.equal(remote.getStatus().connected, true, remote.getStatus().error)

  const job = await remote.call('createJob', [{ name: 'Shared Bid' }])
  assert.equal(job.updatedBy, 'Remote User')
  const seenByHost = await host.call('listJobs', [])
  assert.equal(seenByHost.length, 1)

  const before = changes
  await host.call('updateJob', [job.id, { name: 'Shared Bid (renamed)' }])
  for (let i = 0; i < 40 && changes === before; i++) await sleep(50)
  assert.ok(changes > before, 'remote was told about the host change')
  const d = await remote.call('getJob', [job.id])
  assert.equal(d.job.name, 'Shared Bid (renamed)')

  const bad = new BidBackend(() => 'X', () => {}, () => {})
  backends.push(bad)
  await bad.configure({ mode: 'remote', url: `http://127.0.0.1:${port}`, key: 'wrong', port: 0, https: false, username: '', token: '', certPem: '' })
  for (let i = 0; i < 40 && !bad.getStatus().error; i++) await sleep(50)
  assert.match(bad.getStatus().error, /key was rejected/)
  await assert.rejects(bad.call('listJobs', []), /Sign in|Invalid team key/)
  } finally {
    for (const b of backends.reverse()) await b.shutdown()
  }
})