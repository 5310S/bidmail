import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { BidStore } from '../src/shared/store'
import { startTeamServer } from '../src/shared/teamServer'
import { bidderStage, effectiveTradeStatus, fillTemplate } from '../src/shared/types'
import { mergeFields } from '../src/shared/merge'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bidstore-')), 'test.db')

test('job, trades, bidders and status checkpoints', () => {
  const s = new BidStore(tmp())
  assert.equal(s.listTemplates().length, 3, 'invitation, follow-up and addendum templates are seeded')
  const job = s.createJob({ name: 'Riverside MOB', bidDue: '2026-11-04T19:00:00.000Z', drawingsLink: 'https://x/drawings' }, 'Kei')
  s.addTrades(job.id, [{ name: 'Electrical', csiCode: '26 00 00' }, { name: 'Plumbing', csiCode: '22 00 00' }])
  const d = s.getJob(job.id)!
  assert.equal(d.trades.length, 2)
  const elec = d.trades.find((t) => t.name === 'Electrical')!
  const a = s.addBidder(elec.id, { companyName: 'ABC Electric', contactName: 'Mike Jones', email: 'mike@abc.com' })
  const b = s.addBidder(elec.id, { companyName: 'Volt Bros', email: 'est@volt.com, owner@volt.com' })
  s.addBidder(elec.id, { companyName: 'Spark Co', email: 'bids@spark.com' })
  assert.equal(bidderStage(a), 'not_contacted')

  s.bidderAction(a.id, 'drawings_sent', {}, 'Kei')
  let after = s.bidderAction(a.id, 'follow_up_call', { note: 'left vm' }, 'Kei')
  assert.equal(after.followUpCount, 1)
  after = s.bidderAction(a.id, 'follow_up_email', {}, 'Kei')
  assert.equal(after.followUpCount, 2)
  assert.equal(bidderStage(after), 'followed_up')
  after = s.bidderAction(a.id, 'price_received', { amount: 125000 }, 'Kei')
  assert.equal(after.priceAmount, 125000)
  assert.equal(bidderStage(after), 'priced')
  s.bidderAction(b.id, 'declined')

  let t = s.getJob(job.id)!.trades.find((x) => x.id === elec.id)!
  assert.equal(effectiveTradeStatus(t), 'pricing')
  const acts = s.listActivities(job.id, a.id)
  assert.equal(acts.length, 4)
  assert.ok(acts.every((x) => x.userName === 'Kei'))

  s.bidderAction(a.id, 'clear_price')
  t = s.getJob(job.id)!.trades.find((x) => x.id === elec.id)!
  assert.equal(t.bidders.find((x) => x.id === a.id)!.priceReceivedAt, null)

  s.updateTrade(elec.id, { status: 'covered' })
  const summary = s.listJobs()[0]
  assert.equal(summary.tradeCount, 2)
  assert.equal(summary.tradesCovered, 1)
  assert.equal(summary.bidderCount, 3)
  assert.equal(summary.invitedCount, 1)

  const idx = s.emailIndex()
  assert.deepEqual(idx.map((e) => e.email).sort(), ['bids@spark.com', 'est@volt.com', 'mike@abc.com', 'owner@volt.com'])

  const csv = s.exportJobCsv(job.id)
  assert.match(csv, /ABC Electric/)
  assert.equal(csv.split('\r\n').length, 1 + 3 + 1) // header + 3 electrical + empty plumbing row

  const job2 = s.createJob({ name: 'Copy' })
  s.copyTrades(job2.id, job.id, true)
  const d2 = s.getJob(job2.id)!
  assert.equal(d2.trades.length, 2)
  assert.equal(d2.trades.flatMap((x) => x.bidders).length, 3)
  assert.ok(d2.trades.flatMap((x) => x.bidders).every((x) => !x.drawingsSentAt && !x.priceReceivedAt), 'statuses reset on copy')

  s.deleteJob(job.id)
  assert.equal(s.getJob(job.id), null)
  assert.equal(s.listActivities(job.id).length, 0)
  s.close()
})

test('company directory import de-duplicates', () => {
  const s = new BidStore(tmp())
  let r = s.importCompanies([{ name: 'ABC Electric', email: 'mike@abc.com', trades: 'Electrical' }, { name: 'Volt', email: 'v@volt.com' }, { name: '' }])
  assert.deepEqual(r, { added: 2, updated: 0 })
  r = s.importCompanies([{ name: 'abc electric', email: 'MIKE@abc.com', phone: '555-1212' }])
  assert.deepEqual(r, { added: 0, updated: 1 })
  assert.equal(s.listCompanies().length, 2)
  assert.equal(s.listCompanies('volt').length, 1)
  assert.equal(s.listCompanies().find((c) => c.name === 'ABC Electric')!.phone, '555-1212')
  s.close()
})

test('merge fields fill templates', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'Riverside <MOB>', drawingsLink: 'https://drive/x', specsLink: '' })
  const tr = s.addTrade(job.id, { name: 'Electrical' })
  const b = s.addBidder(tr.id, { companyName: 'ABC', contactName: 'Mike Jones', email: 'm@a.com' })
  const b2 = s.addBidder(tr.id, { companyName: 'NoName' })
  const f = mergeFields(job, tr, b, { name: 'Kei', company: 'Ashlar' })
  const html = fillTemplate('Hi {{first_name|there}}, {{job_name}}: {{drawings_link}} / {{specs_link|n/a}}', f)
  assert.equal(html, 'Hi Mike, Riverside &lt;MOB&gt;: <a href="https://drive/x">https://drive/x</a> / n/a')
  const f2 = mergeFields(job, tr, b2, { name: 'Kei', company: 'Ashlar' })
  assert.equal(fillTemplate('Hi {{first_name|there}},', f2), 'Hi there,')
  assert.equal(fillTemplate('{{trade}} - {{job_name}}', f, false), 'Electrical - Riverside <MOB>')
  s.close()
})

test('team server: auth, RPC and live change events', async () => {
  const s = new BidStore(tmp())
  const srv = await startTeamServer({ store: s, port: 0, key: 'secret-key', host: '127.0.0.1' })
  const base = `http://127.0.0.1:${srv.port}`
  try {
    const health = await (await fetch(base + '/health')).json()
    assert.equal(health.ok, true)

    const bad = await fetch(base + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' })
    assert.equal(bad.status, 401)

    const ctrl = new AbortController()
    const events: number[] = []
    const sse = await fetch(base + '/events', { headers: { Authorization: 'Bearer secret-key' }, signal: ctrl.signal })
    const reader = sse.body!.getReader()
    const pump = (async () => {
      const dec = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value)
          for (const m of buf.matchAll(/data: (\{.*?\})\n\n/g)) events.push(JSON.parse(m[1]).revision)
          buf = buf.slice(buf.lastIndexOf('\n\n') + 2)
        }
      } catch {
        /* aborted */
      }
    })()

    const rpc = async (method: string, args: unknown[]) => {
      const r = await fetch(base + '/rpc', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-key', 'Content-Type': 'application/json', 'X-User': encodeURIComponent('Pat Smith') },
        body: JSON.stringify({ method, args })
      })
      return r.json()
    }
    const created = await rpc('createJob', [{ name: 'Shared Job' }])
    assert.equal(created.ok, true)
    assert.equal(created.result.updatedBy, 'Pat Smith')
    const list = await rpc('listJobs', [])
    assert.equal(list.result.length, 1)
    const nope = await rpc('close', [])
    assert.equal(nope.ok, false, 'non-whitelisted methods are refused')

    await new Promise((r) => setTimeout(r, 150))
    ctrl.abort()
    await pump
    assert.ok(events.length >= 2, 'got initial revision and a change event')
    assert.ok(events[events.length - 1] > events[0])
  } finally {
    await srv.close()
    s.close()
  }
})