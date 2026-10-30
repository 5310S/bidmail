// Bidding workflow: takeoff per job, milestones from the team template, customizable steps with
// "who and when" on every check, and attribution on every change to the workflow itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { BidStore } from '../src/shared/store'
import { DEFAULT_WORKFLOW, furthestStep, stepState } from '../src/shared/types'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-')), 'test.db')
const day = 86400000

test('new jobs get the standard milestones, dated back from the bid due date', () => {
  const s = new BidStore(tmp())
  const due = new Date(Date.UTC(2026, 10, 20, 19, 0)).toISOString()
  const job = s.call('createJob', [{ name: 'Riverside', bidDue: due }], 'Kei')
  const ms = s.getJob(job.id)!.milestones
  assert.deepEqual(ms.map((m) => m.name).sort(), DEFAULT_WORKFLOW.milestones.map((m) => m.name).sort())
  const subs = ms.find((m) => m.name === 'Sub bids due')!
  assert.equal(subs.dueAt, new Date(Date.parse(due) - day).toISOString(), '1 day before bid due')
  assert.equal(ms.find((m) => m.name === 'Pre-bid meeting')!.dueAt, null, 'no default date')
  assert.equal(subs.updatedBy, 'Kei')

  const pre = ms.find((m) => m.name === 'Pre-bid meeting')!
  const upd = s.call('updateMilestone', [pre.id, { dueAt: '2026-11-10T15:00:00.000Z', owner: 'Pat' }], 'Pat Smith')
  assert.deepEqual([upd.owner, upd.updatedBy], ['Pat', 'Pat Smith'])
  s.call('updateMilestone', [pre.id, { doneAt: '2026-11-10T16:00:00.000Z' }], 'Pat Smith')
  const extra = s.call('addMilestone', [job.id, { name: 'Site walk', dueAt: '2026-11-12T14:00:00.000Z' }], 'Kei')
  s.call('deleteMilestone', [extra.id], 'Kei')
  s.call('deleteMilestone', [subs.id], 'Kei')
  s.call('applyMilestoneTemplate', [job.id], 'Kei')
  assert.equal(s.getJob(job.id)!.milestones.filter((m) => m.name === 'Sub bids due').length, 1, 'only missing ones are re-added')
  const log = s.listAudit(job.id).map((x) => `${x.userName}: ${x.summary}`)
  assert.ok(log.includes('Pat Smith: Completed milestone "Pre-bid meeting"'))
  assert.ok(log.includes('Kei: Added milestone "Site walk"'))
  s.close()
})

test('one takeoff per job: assignee, status, due date, and who changed it', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'J' })
  assert.equal(s.getJob(job.id)!.job.takeoff.status, 'not_started')
  s.call('setTakeoff', [job.id, { assignee: 'Pat Smith', status: 'in_progress', dueAt: '2026-11-15T22:00:00.000Z' }], 'Kei')
  let t = s.getJob(job.id)!.job.takeoff
  assert.deepEqual([t.assignee, t.status, t.updatedBy], ['Pat Smith', 'in_progress', 'Kei'])
  s.call('setTakeoff', [job.id, { status: 'done' }], 'Pat Smith')
  t = s.getJob(job.id)!.job.takeoff
  assert.deepEqual([t.assignee, t.status, t.updatedBy], ['Pat Smith', 'done', 'Pat Smith'], 'other fields are kept')
  assert.equal(s.listAudit(job.id)[0].summary, 'Takeoff: status done')
  s.close()
})

test('customizable steps: who ticked what and when, built-ins tick themselves', () => {
  const s = new BidStore(tmp())
  const wf = s.getWorkflow()
  assert.equal(wf.steps.length, 5)
  // Add a custom step, rename a built-in, turn one off; each change carries the name.
  const next = s.call('saveWorkflow', [{
    ...wf,
    steps: [
      ...wf.steps.map((x) => (x.kind === 'follow_up' ? { ...x, name: 'Phone call' } : x.kind === 'will_bid' ? { ...x, enabled: false } : x)),
      { id: 'scope', name: 'Scope review call', kind: 'custom', enabled: true, changedBy: '', changedAt: '' }
    ]
  }], 'Pat Smith')
  assert.equal(next.updatedBy, 'Pat Smith')
  assert.equal(next.steps.find((x: any) => x.id === 'follow_up').changedBy, 'Pat Smith')
  assert.equal(next.steps.find((x: any) => x.id === 'drawings_sent').changedBy, '', 'untouched steps keep their history')
  assert.equal(next.steps.find((x: any) => x.id === 'scope').kind, 'custom')
  // Built-ins can't be deleted (they come back, turned off) and their behaviour can't be changed.
  const trimmed = s.call('saveWorkflow', [{ ...next, steps: next.steps.filter((x: any) => x.kind !== 'filed').map((x: any) => (x.id === 'scope' ? { ...x, kind: 'price_received' } : x)) }], 'Kei')
  assert.equal(trimmed.steps.find((x: any) => x.kind === 'filed').enabled, false)
  assert.equal(trimmed.steps.find((x: any) => x.id === 'scope').kind, 'custom')
  assert.throws(() => s.saveWorkflow({ ...trimmed, steps: trimmed.steps.map((x: any) => ({ ...x, enabled: false })) }, 'Kei'), /at least one step/)

  const job = s.createJob({ name: 'J' })
  const tr = s.addTrade(job.id, { name: 'Electrical' })
  const b = s.addBidder(tr.id, { companyName: 'ABC' })
  s.call('bidderAction', [b.id, 'drawings_sent', {}], 'Kei')
  s.call('bidderAction', [b.id, 'follow_up_call', {}], 'Pat Smith')
  s.call('setBidderStep', [b.id, 'scope', true], 'Pat Smith')
  let d = s.getJob(job.id)!
  let B = d.trades[0].bidders[0]
  const steps = s.getWorkflow().steps.filter((x) => x.enabled)
  const by = (id: string) => { const st = stepState(B, steps.find((x) => x.id === id)!, d.files); return st.done ? st.by : null }
  assert.equal(by('drawings_sent'), 'Kei')
  assert.equal(by('follow_up'), 'Pat Smith')
  assert.equal(by('scope'), 'Pat Smith')
  assert.equal(by('price_received'), null)

  // "Quote filed" ticks itself when a quote is saved to the company.
  const filedStep = { ...DEFAULT_WORKFLOW.steps.find((x) => x.kind === 'filed')!, enabled: true }
  assert.equal(stepState(B, filedStep, d.files).done, false)
  s.call('addFile', [job.id, b.id, 'quote.pdf', 'application/pdf', Buffer.from('x').toString('base64')], 'Kei')
  d = s.getJob(job.id)!
  B = d.trades[0].bidders[0]
  const f = stepState(B, filedStep, d.files)
  assert.ok(f.done && f.by === 'Kei')

  s.call('bidderAction', [b.id, 'price_received', { amount: 100 }], 'Kei')
  d = s.getJob(job.id)!
  B = d.trades[0].bidders[0]
  assert.equal(furthestStep(B, steps, d.files), steps.findIndex((x) => x.id === 'scope'), 'furthest completed step in order')
  s.call('setBidderStep', [b.id, 'scope', false], 'Kei')
  assert.equal(s.getJob(job.id)!.trades[0].bidders[0].steps.scope, undefined)
  assert.ok(s.listAudit(job.id).some((x) => x.summary === 'ABC (Electrical): unchecked Scope review call' && x.userName === 'Kei'))
  s.close()
})

test('My tasks on Today: takeoff and milestones with owners', () => {
  const s = new BidStore(tmp())
  const job = s.createJob({ name: 'Riverside', bidDue: new Date(Date.now() + 8 * day).toISOString() })
  s.setTakeoff(job.id, { assignee: 'Pat Smith', dueAt: new Date(Date.now() + 3 * day).toISOString() }, 'Kei')
  const ms = s.getJob(job.id)!.milestones
  s.updateMilestone(ms.find((m) => m.name === 'RFI deadline')!.id, { owner: 'Kei' }, 'Kei')
  s.updateMilestone(ms.find((m) => m.name === 'Invitations out')!.id, { doneAt: new Date().toISOString() }, 'Kei')
  const tasks = s.todaySummary().tasks
  assert.ok(tasks.some((t) => t.kind === 'takeoff' && t.owner === 'Pat Smith'))
  assert.ok(tasks.some((t) => t.title === 'RFI deadline' && t.owner === 'Kei'))
  assert.ok(!tasks.some((t) => t.title === 'Invitations out'), 'done milestones drop off')
  s.setTakeoff(job.id, { status: 'checked' }, 'Kei')
  assert.ok(!s.todaySummary().tasks.some((t) => t.kind === 'takeoff'))
  s.close()
})

test('databases from earlier versions open with an empty takeoff and no milestones', () => {
  const file = tmp()
  const s1 = new BidStore(file)
  const job = s1.createJob({ name: 'Old' })
  s1.close()
  // Simulate a 1.1 database: no takeoff value, no milestones.
  const { DatabaseSync } = require('node:sqlite')
  const raw = new DatabaseSync(file)
  raw.exec(`UPDATE jobs SET takeoff = '{}'; DELETE FROM milestones;`)
  raw.close()
  const s2 = new BidStore(file)
  const d = s2.getJob(job.id)!
  assert.equal(d.job.takeoff.status, 'not_started')
  assert.equal(d.milestones.length, 0)
  assert.equal(s2.applyMilestoneTemplate(job.id, 'Kei').length, DEFAULT_WORKFLOW.milestones.length)
  s2.close()
})