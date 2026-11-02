// Job folders: which emails belong to which job, and each email shown without the older emails quoted in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JobMailMatcher, searchTerms, subjectNames } from '../src/shared/jobMail'
import { splitTextQuote } from '../src/renderer/src/mail/quotes'

const jobs = [
  { id: 'tobha', name: 'TOBHA Facade Rehab', number: '25-011' },
  { id: 'smith', name: "Smithtown Clerk's Office", number: '' },
  { id: 'barn', name: 'EES Maintenance Barn', number: '25-020' }
]
const idx = (email: string, jobId: string) => ({ email, jobId, bidderId: 'b', companyName: 'c', tradeName: 't', tradeId: 't', jobName: '' })
const index = [
  idx('arthur@clovercontracting.net', 'tobha'),
  idx('lisa@parkplumbing.com', 'tobha'),
  idx('lisa@parkplumbing.com', 'barn'),
  idx('estimating@gmail.com', 'smith')
]
const m = new JobMailMatcher(jobs, index, ['michaelg@ashlarcontracting.com'])
const a = (address: string) => ({ name: '', address })
const msg = (from: string, subject: string, to: string[] = []) => ({ from: [a(from)], to: to.map(a), cc: [], subject })

test('the subject names a job by its number or the distinctive words of its name', () => {
  assert.ok(subjectNames('REQUEST FOR BID - DUE 11/2 - TOBHA FACADE', jobs[0]))
  assert.ok(subjectNames('RE: 25-011 pricing', jobs[0]))
  assert.ok(subjectNames("Bid Due: Smithtown Clerk's Office", jobs[1]))
  assert.ok(!subjectNames('Smithtown School District', jobs[1]), 'one shared word is not enough')
  assert.ok(!subjectNames('Facade repair at the library', jobs[0]), 'the common words alone are not the job')
  assert.ok(!subjectNames('Invoice 125-0110', jobs[0]), 'a number inside another number does not count')
  assert.ok(subjectNames('Bid Due: TOBHA Facade', { id: 'x', name: 'TOBHA - Drawings - Conformed Add 1', number: '' }), "a drawing set's title: the project's own word")
  assert.ok(subjectNames('Bid Due: EES Maintenance Barn', { id: 'x', name: 'ESSD2603 EES Barn - Drawings - Conformed Add 1', number: '' }))
  assert.ok(!subjectNames('Conformed drawings attached', { id: 'x', name: 'TOBHA - Drawings - Conformed Add 1', number: '' }))
})

test('emails go to the jobs of the companies they are to or from', () => {
  assert.deepEqual(m.jobsFor(msg('arthur@clovercontracting.net', 'Masonry proposal'), false), ['tobha'])
  assert.deepEqual(m.jobsFor(msg('mike@clovercontracting.net', 'Our number'), false), ['tobha'], 'a colleague at the same company')
  assert.deepEqual(m.jobsFor(msg('other@gmail.com', 'Hello'), false), [], 'free mail addresses only match exactly')
  assert.deepEqual(m.jobsFor(msg('jessica@ashlarcontracting.com', 'Bid Due: EES Maintenance Barn'), false), ['barn'], 'your own people count only by subject')
  assert.deepEqual(m.jobsFor(msg('michaelg@ashlarcontracting.com', 'Request for bid', ['arthur@clovercontracting.net']), true), ['tobha'], 'sent mail by its recipients')
})

test('a company on several jobs: the subject decides, or the email shows in each', () => {
  assert.deepEqual(m.jobsFor(msg('lisa@parkplumbing.com', 'Re: EES Maintenance Barn plumbing'), false), ['barn'])
  assert.deepEqual(m.jobsFor(msg('lisa@parkplumbing.com', 'Our pricing'), false).sort(), ['barn', 'tobha'])
})

test('each email shows what its sender wrote, not the older emails quoted under it', () => {
  const outlook = 'I can go.\n\nRobert\n\n________________________________\nFrom: Jessica Schief <jessica@ashlar.com>\nSent: Friday, October 16, 2026 3:02 PM\nTo: Robert\nSubject: TOB Facade\n\nWho can go to the site walk?'
  assert.deepEqual(splitTextQuote(outlook, 'RE: TOB Facade'), { main: 'I can go.\n\nRobert', quoted: true })
  const gmail = 'Sounds good.\n\nOn Fri, Oct 16, 2026 at 3:02 PM Jessica Schief <jessica@ashlar.com> wrote:\n> Who can go?\n> Thanks'
  assert.equal(splitTextQuote(gmail, 'Re: TOB').main, 'Sounds good.')
  assert.equal(splitTextQuote('Thanks\n\n-----Original Message-----\nFrom: x', 'RE: y').main, 'Thanks')
  assert.equal(splitTextQuote(outlook, 'FW: TOB Facade').quoted, false, 'a forward is shown whole')
  assert.equal(splitTextQuote('From: a@b.com\nSent: today\nSubject: x\n\nbody', 'RE: x').quoted, false, 'never leaves an email empty')
  assert.equal(splitTextQuote('Plain note with no quote', 'Hi').quoted, false)
})

test("what to search for: the job's number and distinctive words, its companies by domain (or address at free mail)", () => {
  const t = searchTerms({ id: 'x', name: 'TOBHA - Drawings - Conformed Add 1', number: '25-011' }, ['arthur@clovercontracting.net', 'bob@gmail.com', 'me@ashlarcontracting.com'], ['michaelg@ashlarcontracting.com'])
  assert.deepEqual(t.subjects, ['25-011', 'tobha'])
  assert.deepEqual(t.people, ['clovercontracting.net', 'bob@gmail.com', 'me@ashlarcontracting.com'])
})
