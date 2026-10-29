// New data features: upgrades, addenda, will-bid, Today, leveling, quote files, prequalification, users, change log.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { BidStore } from '../src/shared/store'
import { bidderStage, effectiveTradeStatus, expiresSoon, leveledTotal } from '../src/shared/types'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bidstore2-')), 'test.db')
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString()

test('opens a database made by version 1.0.0 and upgrades it in place', () => {
  const file = tmp()
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, number TEXT DEFAULT '', client TEXT DEFAULT '', location TEXT DEFAULT '',
    bid_due TEXT, drawings_link TEXT DEFAULT '', specs_link TEXT DEFAULT '', folder_path TEXT DEFAULT '', notes TEXT DEFAULT '',
    status TEXT DEFAULT 'bidding', created_at TEXT, updated_at TEXT, updated_by TEXT DEFAULT '');
    CREATE TABLE trades (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, name TEXT NOT NULL, csi_code TEXT DEFAULT '', status TEXT DEFAULT 'auto',
    notes TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE bidders (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, trade_id TEXT NOT NULL, company_id TEXT, company_name TEXT NOT NULL,
    contact_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '', drawings_sent_at TEXT, last_follow_up_at TEXT,
    follow_up_count INTEGER DEFAULT 0, price_received_at TEXT, price_amount REAL, declined_at TEXT, notes TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
    CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, contact_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
    trades TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
    CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'other', subject TEXT DEFAULT '', body TEXT DEFAULT '', updated_at TEXT);
    INSERT INTO templates VALUES ('t1','Bid Invitation','invite','s','b','x');
    INSERT INTO jobs(id, name) VALUES ('j1', 'Old Job');
    INSERT INTO trades(id, job_id, name) VALUES ('tr1', 'j1', 'Electrical');
    INSERT INTO bidders(id, job_id, trade_id, company_name, price_amount, price_received_at) VALUES ('b1', 'j1', 'tr1', 'ABC', 1000, '2026-10-01T00:00:00Z');
    INSERT INTO companies(id, name) VALUES ('c1', 'ABC');`)
  old.close()
  const s = new BidStore(file)
  const d = s.getJob('j1')!
  assert.equal(d.job.name, 'Old Job')
  assert.deepEqual(d.job.alternates, [])
  assert.deepEqual(d.trades[0].scopeItems, [])
  assert.equal(d.trades[0].bidders[0].priceAmount, 1000)
  assert.deepEqual(d.trades[0].bidders[0].scope, {})
  assert.equal(s.listCompanies()[0].prequalified, false)
  assert.ok(s.listTemplates().some((t) => t.kind === 'addendum'), 'addendum template added to old databases')
  s.close()
})

test('addenda: send stamps, acknowledgments and what is still missing', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'Riverside', bidDue: new Date(Date.now() + 5 * 86400000).toISOString() })
  const tr = s.addTrade(job.id, { name: 'Electrical' })
  const a = s.addBidder(tr.id, { companyName: 'ABC', email: 'a@x.com' })
  const b = s.addBidder(tr.id, { companyName: 'Volt', email: 'v@x.com' })
  const c = s.addBidder(tr.id, { companyName: 'Never invited' })
  for (const x of [a, b]) s.bidderAction(x.id, 'drawings_sent')
  const add1 = s.call('addAddendum', [job.id, { title: 'Revised electrical plans', link: 'https://x/add1' }], 'Kei')
  assert.equal(add1.number, '1')
  const add2 = s.addAddendum(job.id, { title: 'Bid date moved' })
  assert.equal(add2.number, '2')

  let today = s.todaySummary()
  assert.deepEqual(today.addenda.map((x) => [x.number, x.notSent]), [['1', 2], ['2', 2]], 'only invited companies count')

  s.call('markAddendumSent', [add1.id, [a.id, b.id]], 'Kei')
  s.call('setAddendumAck', [add1.id, a.id], 'Kei')
  const d = s.getJob(job.id)!
  const ba = d.trades[0].bidders.find((x) => x.id === a.id)!
  assert.ok(ba.addendaSent[add1.id] && ba.addendaAck[add1.id])
  assert.ok(!d.trades[0].bidders.find((x) => x.id === c.id)!.addendaSent[add1.id])
  today = s.todaySummary()
  assert.deepEqual(today.addenda.map((x) => [x.number, x.notSent, x.notAcknowledged]), [['1', 0, 1], ['2', 2, 0]])
  assert.ok(s.listActivities(job.id, a.id).some((x) => x.type === 'addendum_sent'))
  assert.match(s.exportJobCsv(job.id), /Addendum 1 Sent/)
  s.deleteAddendum(add2.id)
  assert.equal(s.getJob(job.id)!.addenda.length, 1)
  s.close()
})

test('will bid / not bidding and the Today list', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'Riverside', bidDue: new Date(Date.now() + 1.5 * 86400000).toISOString() })
  const tr = s.addTrade(job.id, { name: 'Plumbing' })
  const fresh = s.addBidder(tr.id, { companyName: 'Fresh', email: 'f@x.com' })
  const stale = s.addBidder(tr.id, { companyName: 'Stale', email: 's@x.com' })
  const priced = s.addBidder(tr.id, { companyName: 'Priced' })
  const noBid = s.addBidder(tr.id, { companyName: 'NoBid' })
  s.bidderAction(fresh.id, 'drawings_sent', { at: daysAgo(0.2) })
  s.bidderAction(stale.id, 'drawings_sent', { at: daysAgo(6) })
  s.bidderAction(priced.id, 'drawings_sent', { at: daysAgo(6) })
  s.bidderAction(priced.id, 'price_received', { amount: 5 })
  s.bidderAction(noBid.id, 'drawings_sent', { at: daysAgo(6) })
  s.bidderAction(noBid.id, 'will_bid')
  assert.equal(bidderStage(s.getJob(job.id)!.trades[0].bidders.find((x) => x.id === noBid.id)!), 'will_bid')
  s.bidderAction(noBid.id, 'declined')
  const nb = s.getJob(job.id)!.trades[0].bidders.find((x) => x.id === noBid.id)!
  assert.equal(nb.willBidAt, null, 'not bidding clears will bid')
  assert.equal(bidderStage(nb), 'declined')
  s.bidderAction(stale.id, 'will_bid')

  const t = s.todaySummary(3)
  assert.deepEqual(t.followUps.map((f) => f.companyName), ['Stale'], 'priced, declined and recently contacted are left out')
  assert.equal(t.followUps[0].willBid, true)
  assert.equal(t.followUps[0].daysSince, 6)
  assert.equal(t.shortTrades.length, 1)
  assert.deepEqual([t.shortTrades[0].priced, t.shortTrades[0].willBid], [1, 1])
  assert.deepEqual(t.dueSoon.map((j) => j.name), ['Riverside'])

  // Within 2 days of the bid date, anyone not contacted for a day shows up too.
  const recent = s.addBidder(tr.id, { companyName: 'Recent', email: 'r@x.com' })
  s.bidderAction(recent.id, 'drawings_sent', { at: daysAgo(1.2) })
  const names = s.todaySummary(3).followUps.map((f) => f.companyName)
  assert.ok(names.includes('Recent') && !names.includes('Fresh'))
  s.updateJob(job.id, { status: 'submitted' })
  assert.equal(s.todaySummary().followUps.length, 0, 'only jobs still bidding')
  s.close()
})

test('bid leveling: scope plugs and accepted alternates', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'J', alternates: [{ id: 'alt1', name: 'Alt 1 - LED upgrade', accepted: true }, { id: 'alt2', name: 'Alt 2', accepted: false }] })
  const tr = s.addTrade(job.id, { name: 'Electrical', scopeItems: ['Fire alarm', 'Temp power'] })
  const a = s.addBidder(tr.id, { companyName: 'A' })
  const b = s.addBidder(tr.id, { companyName: 'B' })
  s.bidderAction(a.id, 'price_received', { amount: 100000 })
  s.bidderAction(b.id, 'price_received', { amount: 95000 })
  s.updateBidder(a.id, { alternatePrices: { alt1: 5000, alt2: 2000 }, scope: { 'Fire alarm': { status: 'included', plug: null } } })
  s.updateBidder(b.id, {
    alternatePrices: { alt1: 4000 },
    scope: { 'Fire alarm': { status: 'excluded', plug: 12000 }, 'Temp power': { status: 'included', plug: null } },
    exclusions: 'Fire alarm by others', inclusions: 'Temp power'
  })
  const d = s.getJob(job.id)!
  const trade = d.trades[0]
  const A = trade.bidders.find((x) => x.companyName === 'A')!
  const B = trade.bidders.find((x) => x.companyName === 'B')!
  assert.equal(leveledTotal(A, trade, d.job), 105000)
  assert.equal(leveledTotal(B, trade, d.job), 95000 + 12000 + 4000, 'B looked low until the excluded fire alarm was added')
  assert.equal(B.exclusions, 'Fire alarm by others')
  assert.deepEqual(trade.scopeItems, ['Fire alarm', 'Temp power'])
  s.close()
})

test('quote files are stored with the job and shared through the database', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'J' })
  const tr = s.addTrade(job.id, { name: 'Electrical' })
  const a = s.addBidder(tr.id, { companyName: 'A' })
  const pdf = Buffer.from('%PDF-1.4 quote')
  const meta = s.call('addFile', [job.id, a.id, 'ABC Quote.pdf', 'application/pdf', pdf.toString('base64')], 'Kei')
  assert.equal(meta.size, pdf.length)
  assert.equal(meta.createdBy, 'Kei')
  assert.equal(s.getJob(job.id)!.files.length, 1)
  assert.equal(Buffer.from(s.getFile(meta.id)!.base64, 'base64').toString(), '%PDF-1.4 quote')
  assert.throws(() => s.addFile(job.id, null, 'big.bin', '', Buffer.alloc(26 * 1024 * 1024).toString('base64')), /25 MB/)
  s.deleteBidder(a.id)
  assert.equal(s.listFiles(job.id)[0].bidderId, null, 'file stays with the job when the company is removed')
  s.close()
})

test('company prequalification details and bidding history', () => {
  const s = new BidStore(tmp())
  const c = s.saveCompany({
    name: 'ABC Electric', email: 'mike@abc.com', glExpires: new Date(Date.now() + 10 * 86400000).toISOString(),
    wcExpires: daysAgo(3), bondingLimit: 2_000_000, union: 'union', certifications: 'MBE, DBE', license: 'TECL 1234', prequalified: true
  })
  assert.equal(c.prequalified, true)
  assert.equal(c.bondingLimit, 2_000_000)
  assert.equal(expiresSoon(c.glExpires), 'soon')
  assert.equal(expiresSoon(c.wcExpires), 'expired')
  for (let i = 0; i < 3; i++) {
    const j = s.createJob({ name: 'Job ' + i })
    const t = s.addTrade(j.id, { name: 'Electrical' })
    // Linked by directory id on two jobs, by matching email on the third.
    const b = s.addBidder(t.id, i < 2 ? { companyId: c.id, companyName: 'ABC Electric' } : { companyName: 'ABC', email: 'MIKE@abc.com' })
    s.bidderAction(b.id, 'drawings_sent')
    if (i === 0) s.bidderAction(b.id, 'price_received', { amount: 1 })
    if (i === 1) s.bidderAction(b.id, 'declined')
  }
  const row = s.listCompanies().find((x) => x.id === c.id)!
  assert.deepEqual([row.invitedCount, row.pricedCount, row.declinedCount], [3, 1, 1])
  assert.ok(row.lastInvitedAt)
  assert.equal(s.listCompanies('DBE').length, 1, 'search covers certifications')
  s.close()
})

test('per-trade links and scope notes', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'J', drawingsLink: 'https://job/all' })
  const tr = s.addTrade(job.id, { name: 'Electrical' })
  s.updateTrade(tr.id, { drawingsLink: 'https://job/electrical-only', scopeNote: 'Include site lighting', scopeItems: ['Site lighting'] })
  const t = s.getJob(job.id)!.trades[0]
  assert.equal(t.drawingsLink, 'https://job/electrical-only')
  assert.equal(t.scopeNote, 'Include site lighting')
  const copy = s.createJob({ name: 'Copy' })
  s.copyTrades(copy.id, job.id, false)
  const ct = s.getJob(copy.id)!.trades[0]
  assert.deepEqual(ct.scopeItems, ['Site lighting'], 'scope checklist copies with the trade')
  assert.equal(ct.drawingsLink, '', 'links are job-specific and do not copy')
  assert.equal(effectiveTradeStatus(ct), 'not_started')
  s.close()
})

test('team users, sessions and the change log', () => {
  const s = new BidStore(tmp())
  assert.equal(s.userCount(), 0)
  const admin = s.createUser({ username: 'kei', displayName: 'Kei Estimator', password: 'correct horse', role: 'admin' })
  assert.throws(() => s.createUser({ username: 'KEI', password: 'whatever123' }), /taken/, 'usernames are case-insensitive')
  assert.throws(() => s.createUser({ username: 'pat', password: 'short' }), /8 characters/)
  const pat = s.createUser({ username: 'pat', password: 'another pass' })
  assert.equal(s.login('kei', 'wrong password'), null)
  const session = s.login('KEI', 'correct horse')!
  assert.equal(s.sessionUser(session.token)?.id, admin.id)
  assert.throws(() => s.updateUser(admin.id, { role: 'member' }), /at least one active admin/)
  s.updateUser(pat.id, { password: 'brand new pass' })
  assert.equal(s.login('pat', 'another pass'), null)
  const p = s.login('pat', 'brand new pass')!
  s.updateUser(pat.id, { active: false })
  assert.equal(s.sessionUser(p.token), null, 'deactivating signs the user out')
  s.logout(session.token)
  assert.equal(s.sessionUser(session.token), null)

  const job = s.call('createJob', [{ name: 'Audit Job' }], 'Kei Estimator')
  const tr = s.call('addTrade', [job.id, { name: 'HVAC' }], 'Pat Smith')
  const b = s.call('addBidder', [tr.id, { companyName: 'Cool Air' }], 'Pat Smith')
  s.call('bidderAction', [b.id, 'price_received', { amount: 250000 }], 'Pat Smith')
  s.call('deleteBidder', [b.id], 'Kei Estimator')
  s.call('listJobs', [], 'Pat Smith')
  const log = s.listAudit(job.id)
  assert.deepEqual(log.map((x) => x.summary).reverse(), [
    'Created job "Audit Job"',
    'Added trade "HVAC"',
    'Added Cool Air to HVAC',
    'Cool Air (HVAC): price received $250,000',
    'Removed Cool Air (HVAC)'
  ])
  assert.equal(log[0].userName, 'Kei Estimator')
  assert.equal(s.listAudit().length, 5, 'reads are not logged')
  s.close()
})