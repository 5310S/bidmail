// Launches the real BidMail window against a local test mail server and seeded bid data,
// clicks through the main screens and saves screenshots to tests/screens/.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { _electron as electron } from 'playwright-core'
import { BidStore } from '../src/shared/store'
import { seedLeopard, startMockLeopard } from './mockLeopard'
import { makeXlsx, VENDOR_ROWS } from './xlsxFixture'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hoodiecrow = require('hoodiecrow-imap')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startSMTPServer } = require('hoodiecrow-imap/lib/hoodiecrowSMTPServer')

const root = path.resolve(__dirname, '..', '..', '..') // bundled into tests/dist/ui/
const shots = path.join(root, 'tests', 'screens')
fs.mkdirSync(shots, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mail(from: string, subject: string, body: string, date: string, extra = '') {
  return {
    raw: `From: ${from}\r\nTo: Kei Estimator <estimator@test.local>\r\nSubject: ${subject}\r\nDate: ${date}\r\nMIME-Version: 1.0\r\n${extra || 'Content-Type: text/html; charset=utf-8\r\n'}\r\n${body}`,
    internaldate: date.replace(/^\w+, /, '').replace(/ (\d\d:\d\d)/, ' $1')
  }
}

async function main() {
  const imap = hoodiecrow({
    plugins: ['IDLE', 'SPECIAL-USE', 'MOVE', 'UIDPLUS', 'LIST-STATUS', 'ENABLE', 'ID', 'UNSELECT', 'NAMESPACE'],
    users: { estimator: { password: 'pw' } },
    storage: {
      INBOX: {
        messages: [
          mail('"Lisa Park" <lisa@parkplumbing.com>', 'Re: Invitation to Bid: Riverside MOB - Plumbing', '<p>Hi Kei,</p><p>We will be bidding this one. Quick question on the med gas scope - is that by plumbing or by owner?</p><p>Lisa Park<br>Park Plumbing</p>', 'Mon, 26 Oct 2026 09:12:00 -0500'),
          mail('"Ray Ortiz" <ray@ortizdrywall.com>', 'Drywall pricing - Riverside', '<p>Kei - number is $412,500 including level 4 finish. Excludes FRP. See attached.</p>', 'Tue, 27 Oct 2026 14:40:00 -0500'),
          mail('"Mike Jones" <mike@abc-electric.com>', 'Riverside MOB - Electrical proposal', '<div style="font-family:Arial"><p>Kei,</p><p>Attached is our proposal for <b>$1,245,000</b>. Fire alarm is included.</p><p>Thanks,<br>Mike Jones<br>ABC Electric</p><img src="https://tracker.example/p.gif"></div>', 'Wed, 28 Oct 2026 16:05:00 -0500'),
          {
            raw: ['From: "Pat Turner" <pat@turnergc.com>', 'To: estimator@test.local', 'Subject: Invitation: Riverside MOB - Pre-Bid Meeting', 'Date: Wed, 28 Oct 2026 08:00:00 -0500', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="alt"', '', '--alt', 'Content-Type: text/plain', '', 'Pre-bid meeting at the site trailer. Hard hats required.', '--alt', 'Content-Type: text/calendar; method=REQUEST', '', 'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:prebid-777@turnergc.com', 'ORGANIZER;CN=Pat Turner:mailto:pat@turnergc.com', 'SUMMARY:Riverside MOB - Pre-Bid Meeting', 'LOCATION:Site trailer, 1200 Riverside Dr', 'DTSTART;TZID=Central Standard Time:20261103T100000', 'DTEND;TZID=Central Standard Time:20261103T110000', 'END:VEVENT', 'END:VCALENDAR', '--alt--', ''].join('\r\n'),
            internaldate: '28-Oct-2026 08:00:00 -0500'
          },
          {
            raw: 'From: "Mike Jones" <mike@abc-electric.com>\r\nTo: estimator@test.local\r\nSubject: Re: Riverside MOB - Electrical proposal\r\nMessage-ID: <reply-2@abc-electric.com>\r\nIn-Reply-To: <prop-1@abc-electric.com>\r\nDate: Wed, 28 Oct 2026 17:20:00 -0500\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>One more thing: our number excludes site lighting poles and bases.</p><p>Mike</p>',
            internaldate: '28-Oct-2026 17:20:00 -0500'
          },
          mail('"Plan Room" <noreply@planroom.example>', 'Addendum 2 issued - Riverside Medical Office Building', '<p>Addendum 2 has been issued. 14 sheets revised: A-101, A-102, M-201...</p>', 'Thu, 29 Oct 2026 07:30:00 -0500')
        ]
      },
      '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' }, Drafts: { 'special-use': '\\Drafts' }, Trash: { 'special-use': '\\Trash' }, Archive: { 'special-use': '\\Archive' } } }
    }
  })
  await new Promise<void>((r) => imap.listen(22143, '127.0.0.1', () => r()))
  // A second account, for "All Inboxes".
  const imap2 = hoodiecrow({
    plugins: ['IDLE', 'SPECIAL-USE', 'MOVE', 'UIDPLUS', 'LIST-STATUS', 'ENABLE', 'ID', 'UNSELECT', 'NAMESPACE'],
    users: { kei2: { password: 'pw' } },
    storage: {
      INBOX: { messages: [mail('"Halvorsen Dev." <pm@halvorsen.example>', 'Cedar Park - bid results next week', '<p>We expect to award next Tuesday.</p>', 'Thu, 29 Oct 2026 06:10:00 -0500')] },
      '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' }, Trash: { 'special-use': '\\Trash' } } }
    }
  })
  await new Promise<void>((r) => imap2.listen(22144, '127.0.0.1', () => r()))
  const smtp = await new Promise<any>((r) => { const s = startSMTPServer(22587, imap, () => r(s)) })

  // Leopard (takeoff software): an account with the same email as the mail account, one project with a takeoff.
  const leo = await startMockLeopard()
  seedLeopard(leo, 'estimator@test.local', 'leopard-pass')

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmail-ui-'))
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userName: 'Kei Estimator', companyName: 'Ashlar Contracting', reading: { fontSize: 16, theme: 'light' }, leopard: { url: leo.url, email: '', cookie: '' } }))
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify([{
    id: 'acct1', displayName: 'Kei Estimator', email: 'estimator@test.local', signature: '<p>Kei Estimator<br>Ashlar Contracting</p>', color: '#2f6fdb',
    imap: { host: '127.0.0.1', port: 22143, secure: false, user: 'estimator' }, smtp: { host: '127.0.0.1', port: 22587, secure: false, user: 'estimator' },
    saveSentCopy: true, allowInvalidCerts: true, password: 'b64:' + Buffer.from('pw').toString('base64')
  }, {
    id: 'acct2', displayName: 'Kei (personal)', email: 'kei2@test.local', signature: '', color: '#d9622b',
    imap: { host: '127.0.0.1', port: 22144, secure: false, user: 'kei2' }, smtp: { host: '127.0.0.1', port: 22587, secure: false, user: 'kei2' },
    saveSentCopy: false, allowInvalidCerts: true, password: 'b64:' + Buffer.from('pw').toString('base64')
  }]))

  const s = new BidStore(path.join(data, 'bidmail.db'))
  const due = new Date(Date.now() + 4 * 86400000)
  due.setHours(14, 0, 0, 0)
  const job = s.createJob({ name: 'Riverside Medical Office Building', number: '26-114', client: 'Turner Health Partners', location: 'Austin, TX', bidDue: due.toISOString(), drawingsLink: 'https://files.example.com/riverside/drawings', specsLink: 'https://files.example.com/riverside/specs' }, 'Kei')
  s.addTrades(job.id, [
    { name: 'Electrical', csiCode: '26 00 00' }, { name: 'Plumbing', csiCode: '22 00 00' }, { name: 'HVAC', csiCode: '23 00 00' },
    { name: 'Drywall & Framing', csiCode: '09 21 00' }, { name: 'Painting', csiCode: '09 91 00' }
  ])
  const d = s.getJob(job.id)!
  const T = (n: string) => d.trades.find((t) => t.name === n)!.id
  const add = (t: string, companyName: string, contactName: string, email: string, phone = '') => s.addBidder(T(t), { companyName, contactName, email, phone })
  const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString()
  const e1 = add('Electrical', 'ABC Electric', 'Mike Jones', 'mike@abc-electric.com', '512-555-0142')
  const e2 = add('Electrical', 'Volt Brothers', 'Sam Volt', 'sam@voltbros.com', '512-555-0199')
  const e3 = add('Electrical', 'Lone Star Power', '', 'bids@lonestarpower.com')
  const p1 = add('Plumbing', 'Park Plumbing', 'Lisa Park', 'lisa@parkplumbing.com', '512-555-0110')
  add('Plumbing', 'Capitol Mechanical', 'Dan Reyes', 'dreyes@capmech.com')
  const h1 = add('HVAC', 'Capitol Mechanical', 'Dan Reyes', 'dreyes@capmech.com')
  add('HVAC', 'Air Pros', 'Jen Lee', '')
  const dw1 = add('Drywall & Framing', 'Ortiz Drywall', 'Ray Ortiz', 'ray@ortizdrywall.com', '512-555-0177')
  const dw2 = add('Drywall & Framing', 'Hill Country Interiors', 'Beth Hill', 'beth@hcinteriors.com')
  for (const b of [e1, e2, e3, p1, h1, dw1, dw2]) s.bidderAction(b.id, 'drawings_sent', { at: ago(120) }, 'Kei')
  s.bidderAction(e1.id, 'follow_up_call', { at: ago(50), note: 'Will have it Wednesday' }, 'Kei')
  s.bidderAction(e1.id, 'price_received', { at: ago(20), amount: 1245000 }, 'Kei')
  s.bidderAction(e2.id, 'price_received', { at: ago(10), amount: 1312400 }, 'Kei')
  s.bidderAction(e3.id, 'declined', { at: ago(30) }, 'Kei')
  s.bidderAction(p1.id, 'follow_up_email', { at: ago(26) }, 'Kei')
  s.bidderAction(dw1.id, 'price_received', { at: ago(40), amount: 412500 }, 'Kei')
  s.bidderAction(dw2.id, 'follow_up_call', { at: ago(6), note: 'Left voicemail' }, 'Kei')
  const lake = s.createJob({ name: 'Lakeway Elementary Renovation', number: '26-121', client: 'Lakeway ISD', location: 'Lakeway, TX', bidDue: new Date(Date.now() + 9 * 86400000).toISOString() })
  const roof = s.addTrade(lake.id, { name: 'Roofing', csiCode: '07 50 00' })
  const rf = s.addBidder(roof.id, { companyName: 'Summit Roofing', contactName: 'Al Summit', email: 'al@summitroof.example', phone: '512-555-0123' })
  s.bidderAction(rf.id, 'drawings_sent', { at: ago(6 * 24) }, 'Kei')
  s.createJob({ name: 'Cedar Park Retail Shell', number: '26-098', client: 'Halvorsen Dev.', status: 'submitted' })
  s.importCompanies([
    { name: 'ABC Electric', contactName: 'Mike Jones', email: 'mike@abc-electric.com', phone: '512-555-0142', trades: 'Electrical' },
    { name: 'Park Plumbing', contactName: 'Lisa Park', email: 'lisa@parkplumbing.com', trades: 'Plumbing' },
    { name: 'Bright Line Electric', contactName: 'Tom Bright', email: 'tom@brightline.com', trades: 'Electrical, Low Voltage' },
    { name: 'Ortiz Drywall', contactName: 'Ray Ortiz', email: 'ray@ortizdrywall.com', trades: 'Drywall & Framing' }
  ])
  // Newer features: will bid, an addendum, alternates + scope checklist for leveling, a quote file, prequalification.
  s.bidderAction(dw2.id, 'will_bid', { at: ago(5) }, 'Kei')
  const ad1 = s.addAddendum(job.id, { number: '1', title: 'Revised electrical sheets E-101 to E-104', link: 'https://files.example.com/riverside/add1', issuedAt: ago(48) })
  s.markAddendumSent(ad1.id, [e1.id, e2.id, p1.id], ago(47), 'Kei')
  s.setAddendumAck(ad1.id, e1.id, ago(30), 'Kei')
  s.updateJob(job.id, { alternates: [{ id: 'alt1', name: 'Alt 1: LED fixture upgrade', accepted: true }, { id: 'alt2', name: 'Alt 2: Standby generator', accepted: false }] }, 'Kei')
  s.updateTrade(T('Electrical'), { scopeItems: ['Fire alarm', 'Temp power', 'Site lighting'] })
  const inc = { status: 'included' as const, plug: null }
  s.updateBidder(e1.id, {
    alternatePrices: { alt1: 38000, alt2: 92000 }, inclusions: 'Fire alarm, temp power', exclusions: 'Site lighting poles & bases',
    scope: { 'Fire alarm': inc, 'Temp power': inc, 'Site lighting': { status: 'excluded', plug: 70000 } }
  })
  s.updateBidder(e2.id, { alternatePrices: { alt1: 21000, alt2: 88000 }, inclusions: 'Complete per plans & specs', scope: { 'Fire alarm': inc, 'Temp power': inc, 'Site lighting': inc } })
  s.addFile(job.id, e1.id, 'ABC Electric Proposal.pdf', 'application/pdf', Buffer.from('%PDF-1.4 proposal').toString('base64'), 'Kei')
  const abc = s.listCompanies('ABC Electric')[0]
  s.saveCompany({ id: abc.id, prequalified: true, certifications: 'MBE', glExpires: new Date(Date.now() + 200 * 86400000).toISOString(), wcExpires: new Date(Date.now() - 5 * 86400000).toISOString(), bondingLimit: 3000000, union: 'union' })
  s.updateBidder(e1.id, { companyId: abc.id })
  // Workflow: takeoff assigned to me, a milestone owner, a pre-bid meeting date.
  s.setTakeoff(job.id, { assignee: 'Kei Estimator', status: 'in_progress', dueAt: new Date(Date.now() + 2 * 86400000).toISOString() }, 'Kei')
  const ms = s.getJob(job.id)!.milestones
  s.updateMilestone(ms.find((m) => m.name === 'RFI deadline')!.id, { owner: 'Kei Estimator' }, 'Kei')
  s.updateMilestone(ms.find((m) => m.name === 'Pre-bid meeting')!.id, { dueAt: ago(-24) }, 'Kei')
  s.updateMilestone(ms.find((m) => m.name === 'Bid documents received')!.id, { dueAt: ago(7 * 24), doneAt: ago(7 * 24) }, 'Kei')
  s.close()
  const pdfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmail-pdf-'))
  const errors: string[] = []
  // BIDMAIL_EXE=release\\win-unpacked\\BidMail.exe tests the packaged app instead of the dev build.
  const packaged = process.env.BIDMAIL_EXE
  const app = await electron.launch({
    // require('electron') from Node returns the path of the Electron binary for this OS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    executablePath: packaged ? path.resolve(packaged) : (require('electron') as unknown as string),
    args: packaged ? [] : [root],
    env: { ...process.env, BIDMAIL_DATA_DIR: data, BIDMAIL_PDF_DIR: pdfDir }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  await page.setViewportSize({ width: 1440, height: 900 })
  const shot = async (name: string) => { await sleep(500); await page.screenshot({ path: path.join(shots, name + '.png') }); console.log('saved', name) }

  await page.waitForSelector('.msg-row', { timeout: 20000 })
  await page.locator('.msg-row', { hasText: 'Electrical proposal' }).click()
  await page.waitForSelector('.reader-subject')
  await sleep(800)
  await shot('01-mail-reading')

  await page.locator('button[title="More: print, PDF, rules"]').click()
  await page.locator('.menu-item', { hasText: 'Save as PDF' }).click()
  await sleep(2500)
  const pdfs = fs.readdirSync(pdfDir)
  if (!pdfs.length || !fs.readFileSync(path.join(pdfDir, pdfs[0])).subarray(0, 5).toString().startsWith('%PDF')) throw new Error('email PDF not created')
  console.log('email PDF ok:', pdfs[0], fs.statSync(path.join(pdfDir, pdfs[0])).size, 'bytes')

  await page.locator('.msg-row', { hasText: 'Pre-Bid Meeting' }).click()
  await page.waitForSelector('.invite-card')
  await shot('01b-invite')

  await page.locator('.msg-row', { hasText: 'Drywall pricing' }).click({ modifiers: ['Control'] })
  await page.locator('.msg-row', { hasText: 'Plan Room' }).click({ modifiers: ['Control'] })
  await page.waitForSelector('.bulk-panel')
  await shot('01c-multi-select')
  await page.locator('.bulk-actions button', { hasText: 'Mark read' }).click()
  await sleep(500)
  for (const t of ['Drywall pricing', 'Plan Room', 'Pre-Bid Meeting']) {
    if (await page.locator('.msg-row.unread', { hasText: t }).count()) throw new Error('multi-select mark read did not apply to ' + t)
  }
  if (!(await page.locator('.msg-row.unread', { hasText: 'Lisa Park' }).count())) throw new Error('an unselected message was changed')
  await page.keyboard.press('Escape')
  await page.locator('.side-item', { hasText: 'All Jobs' }).click()
  await page.waitForSelector('.job-card')
  await shot('02-jobs')

  await page.locator('.job-card', { hasText: 'Riverside' }).click()
  await page.waitForSelector('.trade-card')
  await shot('03-job-trades')

  await page.locator('.cp-btn', { hasText: 'Log Follow-Up' }).first().click()
  await sleep(300)
  await shot('04-log-followup')
  await page.keyboard.press('Escape')

  await page.locator('button', { hasText: 'Send Drawings' }).first().click()
  await page.waitForSelector('.bulk-tree')
  await page.locator('.bulk-quick .chip', { hasText: 'Everyone' }).click()
  await shot('05-send-drawings')
  await page.locator('.seg button', { hasText: 'Preview' }).click()
  await shot('06-send-preview')
  await page.locator('.modal-foot button', { hasText: /^Send \d+ emails?$/ }).click()
  await page.waitForSelector('.modal-head h2:has-text("Finished sending")', { timeout: 30000 })
  await shot('07-send-finished')
  await page.locator('.modal-foot button', { hasText: 'Done' }).click()

  await page.locator('.job-title-row button.btn-icon').last().click()
  await page.locator('.menu-item', { hasText: 'Save bid status as PDF' }).click()
  await sleep(2500)
  const jobPdf = fs.readdirSync(pdfDir).find((f) => f.includes('Bid Status'))
  if (!jobPdf) throw new Error('bid status PDF not created')
  console.log('bid status PDF ok:', jobPdf, fs.statSync(path.join(pdfDir, jobPdf)).size, 'bytes')

  await page.locator('.tabs button', { hasText: 'Bid Board' }).click()
  await shot('08-bid-board')
  await page.locator('.tabs button', { hasText: 'Activity' }).click()
  await shot('09-activity')

  await page.locator('.compose-btn').click()
  await page.waitForSelector('.composer')
  await page.locator('.addr-input input').first().fill('lisa')
  await sleep(300)
  await shot('10-compose')
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.locator('.modal-foot button', { hasText: 'Discard' }).click()
  await sleep(200)

  await page.locator('.side-item', { hasText: 'Settings' }).click()
  await page.locator('.tabs button', { hasText: 'Team Sharing' }).click()
  await shot('11-settings-team')
  await page.locator('.side-item', { hasText: 'Companies' }).click()
  await shot('12-companies')

  await page.locator('.side-folder', { hasText: 'Inbox' }).first().click()
  await page.waitForSelector('.msg-row')
  await sleep(1500)
  await shot('13-inbox-after-send')

  // ---- conversations, snooze, all inboxes ----
  const conv = page.locator('.msg-row', { hasText: 'Electrical proposal' })
  if (!(await conv.locator('.conv-count').count())) throw new Error('conversation was not grouped')
  await conv.click()
  await page.waitForSelector('.thread')
  await shot('14-conversation')
  await page.locator('.msg-row', { hasText: 'Plan Room' }).click()
  await page.waitForSelector('.reader-subject')
  await page.locator('button[title="Snooze: hide until later"]').click()
  await page.locator('.menu-item', { hasText: 'Tomorrow morning' }).click()
  await sleep(2000)
  if (await page.locator('.msg-row', { hasText: 'Plan Room' }).count()) throw new Error('snoozed message still listed')
  await page.waitForSelector('.side-folder:has-text("Snoozed")', { timeout: 15000 })
  console.log('snooze ok')
  await page.locator('.side-item', { hasText: 'All Inboxes' }).click()
  await page.waitForSelector('.msg-acct')
  if (!(await page.locator('.msg-row', { hasText: 'Cedar Park - bid results' }).count())) throw new Error('second account missing from All Inboxes')
  await shot('15-all-inboxes')

  // ---- Today ----
  await page.locator('.side-item', { hasText: 'Today' }).click()
  await page.waitForSelector('.today-section')
  await shot('16-today')
  const called = page.locator('.today-section button:has-text("Called")')
  const before = await called.count()
  if (!before) throw new Error('no follow-ups on Today')
  await called.first().click()
  await sleep(1000)
  if ((await called.count()) !== before - 1) throw new Error('logging a call did not clear the follow-up')

  // ---- trades v2, addenda, leveling ----
  await page.locator('.side-job', { hasText: 'Riverside' }).click()
  await page.waitForSelector('.trade-card')
  await shot('17-trades')
  await page.locator('.tabs button', { hasText: 'Addenda' }).click()
  await page.locator('button', { hasText: 'Add Addendum' }).click()
  await page.locator('.modal input').nth(2).fill('Bid date moved to Friday')
  await page.locator('.modal input').nth(3).fill('https://files.example.com/riverside/add2')
  await page.locator('.modal-foot button', { hasText: 'Add Addendum' }).click()
  await page.locator('.modal-foot button', { hasText: 'Send now' }).click()
  await page.waitForSelector('.bulk-tree')
  await shot('18-send-addendum')
  await page.locator('.modal-foot button', { hasText: /^Send \d+ emails?$/ }).click()
  await page.waitForSelector('.modal-head h2:has-text("Finished sending")', { timeout: 30000 })
  await page.locator('.modal-foot button', { hasText: 'Done' }).click()
  await sleep(800)
  await shot('19-addenda')
  const stats = await page.locator('.addendum-stats').first().innerText()
  if (!/(\d+)\/\1 sent/.test(stats)) throw new Error('addendum 2 not marked sent to everyone: ' + stats)
  await page.locator('.tabs button', { hasText: 'Bid Leveling' }).click()
  await page.waitForSelector('.level-table')
  await shot('20-leveling')
  const lowText = await page.locator('.lv-total td.is-low').innerText()
  if (!lowText.includes('1,333,400')) throw new Error('leveled low is wrong: ' + lowText)
  console.log('leveling ok: Volt Brothers is the leveled low even though ABC was lower on paper')

  // ---- company prequalification ----
  await page.locator('.side-item', { hasText: 'Companies' }).click()
  await page.waitForSelector('.data-table')
  await shot('21-companies')
  await page.locator('tr', { hasText: 'ABC Electric' }).locator('button[title="Edit"]').click()
  await page.waitForSelector('.cert-pick')
  await shot('22-company-form')
  await page.keyboard.press('Escape')

  // ---- settings: rules, add account, team hosting with logins, updates ----
  await page.locator('.side-item', { hasText: 'Settings' }).click()
  await page.locator('.tabs button', { hasText: 'Mail Rules' }).click()
  await page.locator('button', { hasText: 'New Rule' }).click()
  await page.locator('.modal input').first().fill('Plan room notices')
  await page.locator('.cond-row input').first().fill('@planroom.example')
  await page.locator('.rule-actions label', { hasText: 'Mark as read' }).click()
  await shot('23-rule-editor')
  await page.locator('.modal-foot button', { hasText: 'Save rule' }).click()
  await page.waitForSelector('.rule-row')
  await page.locator('.tabs button', { hasText: 'Email Accounts' }).click()
  await page.locator('button', { hasText: 'Add Account' }).click()
  await page.waitForSelector('.method-list')
  await shot('24-add-account')
  await page.keyboard.press('Escape')
  await page.locator('.tabs button', { hasText: 'Team Sharing' }).click()
  await page.locator('.mode-card', { hasText: 'Host team data here' }).click()
  await page.locator('button', { hasText: 'Start hosting' }).click()
  await page.waitForSelector('.ok-box:has-text("Hosting is on")', { timeout: 20000 })
  await page.locator('button', { hasText: 'Add teammate' }).click()
  await page.locator('.modal input').nth(0).fill('Pat Smith')
  await page.locator('.modal input').nth(1).fill('pat')
  await page.locator('.modal input').nth(2).fill('temporary-pass-1')
  await page.locator('.modal-foot button', { hasText: 'Create login' }).click()
  await page.waitForSelector('td.mono:has-text("pat")')
  await sleep(500)
  await shot('25-team-host')
  await page.locator('.tabs button', { hasText: 'About & Updates' }).click()
  await shot('26-about')

  // ---- bid workflow: custom step (attributed), timeline, progress board, my tasks ----
  const jobCall = (method: string, args: unknown[]) => page.evaluate(([m, a]) => window.bidmail.invoke('bid:call', m, a), [method, args] as const)
  await page.locator('.tabs button', { hasText: 'Bid Workflow' }).click()
  await page.locator('input[placeholder^="Add a step"]').fill('Scope review call')
  await page.locator('button', { hasText: 'Add step' }).click()
  await page.locator('button', { hasText: 'Save for the team' }).click()
  await page.waitForSelector('text=changed by Kei Estimator')
  await shot('27-workflow-settings')

  await page.locator('.side-job', { hasText: 'Riverside' }).click()
  await page.waitForSelector('.trade-card')
  await page.locator('.tabs button', { hasText: 'Timeline' }).click()
  await page.waitForSelector('.tl-ms')
  await page.locator('.tl-toggle', { hasText: 'Electrical' }).click()
  await sleep(400)
  await shot('28-timeline')
  const pre = page.locator('.tl-ms', { hasText: 'Pre-bid meeting' })
  const before2 = (await jobCall('getJob', [job.id]) as any).milestones.find((m: any) => m.name === 'Pre-bid meeting').dueAt
  const box = (await pre.locator('.tl-diamond').boundingBox())!
  const dayPx = await page.evaluate(() => {
    const days = document.querySelectorAll('.tl-scale .tl-day')
    return (days[1] as HTMLElement).offsetLeft - (days[0] as HTMLElement).offsetLeft
  })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dayPx, box.y + box.height / 2, { steps: 5 })
  await page.mouse.move(box.x + box.width / 2 + dayPx * 2, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await sleep(800)
  const after2 = (await jobCall('getJob', [job.id]) as any).milestones.find((m: any) => m.name === 'Pre-bid meeting')
  const movedDays = Math.round((Date.parse(after2.dueAt) - Date.parse(before2)) / 86400000)
  if (movedDays !== 2) throw new Error('dragging the milestone moved it ' + movedDays + ' days')
  if (after2.updatedBy !== 'Kei Estimator') throw new Error('milestone change not attributed: ' + after2.updatedBy)
  console.log('timeline ok: milestone dragged 2 days, changed by', after2.updatedBy)

  await page.locator('.tabs button', { hasText: 'Progress Board' }).click()
  await page.waitForSelector('.kan-col')
  if (!(await page.locator('.kan-head', { hasText: 'Scope review call' }).count())) throw new Error('custom step column missing')
  await shot('29-progress-board')
  await page.locator('.kanban').evaluate((el) => (el.scrollLeft = el.scrollWidth))
  const card = page.locator('.kan-card', { hasText: 'Hill Country Interiors' })
  await card.dragTo(page.locator('.kan-col', { has: page.locator('.kan-head', { hasText: 'Scope review call' }) }))
  await sleep(800)
  const hill = (await jobCall('getJob', [job.id]) as any).trades.flatMap((t: any) => t.bidders).find((b: any) => b.companyName === 'Hill Country Interiors')
  const wf = (await jobCall('getWorkflow', [])) as any
  const scopeId = wf.steps.find((x: any) => x.name === 'Scope review call').id
  if (!hill.steps[scopeId] || hill.steps[scopeId].by !== 'Kei Estimator') throw new Error('drag did not tick the custom step with a name')
  await page.locator('.kan-card', { hasText: 'Hill Country Interiors' }).click()
  await page.waitForSelector('.step-list')
  await shot('30-card-checklist')
  await page.keyboard.press('Escape')
  console.log('board ok: dragging a card ticked "Scope review call" by Kei Estimator')

  await page.locator('.side-item', { hasText: 'Today' }).click()
  await page.waitForSelector('text=My tasks')
  const myTakeoff = page.locator('.today-section tr', { hasText: 'Takeoff' })
  if (!(await myTakeoff.count())) throw new Error('takeoff missing from My tasks')
  await shot('31-my-tasks')

  // ---- Leopard: sign in with the same email, link the job, import the takeoff, quantities in the RFB email ----
  await page.locator('.side-item', { hasText: 'Settings' }).click()
  await page.locator('.tabs button', { hasText: 'Leopard' }).click()
  await page.waitForSelector('text=The same email')
  await page.locator('input[type="password"]').fill('leopard-pass')
  await page.locator('button', { hasText: 'Sign in to Leopard' }).click()
  await page.waitForSelector('text=Signed in to Leopard as')
  await shot('32-leopard-settings')

  // The vendor list (the same file as Companies > Import Vendor List).
  const vendorFile = path.join(data, 'Subcontractor Vendor List.xlsx')
  fs.writeFileSync(vendorFile, makeXlsx(VENDOR_ROWS))
  const vl = (await page.evaluate((p) => window.bidmail.invoke('vendors:import', p), vendorFile)) as any
  if (vl.total !== 8 || vl.title !== 'Riverside MOB') throw new Error('vendor list import: ' + JSON.stringify(vl))
  console.log('vendor list ok:', vl.total, 'companies,', vl.trades, 'trades')

  await page.locator('.side-job', { hasText: 'Riverside' }).click()
  await page.waitForSelector('.fact.leopard')
  await page.locator('.fact.leopard button', { hasText: 'Link project' }).click()
  await page.waitForSelector('.lp-projects button.best')
  await shot('33-leopard-link')
  await page.locator('.lp-projects button.best').click()
  await page.waitForSelector('.lp-pkg', { timeout: 20000 })
  const concretePkg = page.locator('.lp-pkg', { hasText: 'Concrete' })
  if ((await concretePkg.locator('.lp-cos').innerText()).trim() !== '3 companies') throw new Error('concrete companies: ' + (await concretePkg.locator('.lp-cos').innerText()))
  await concretePkg.locator('.lp-cos').click()
  await page.waitForSelector('.lp-company-list')
  await shot('34-leopard-import')
  await page.locator('.modal-foot button', { hasText: 'Set up 3 trades & 4 companies' }).click()
  await page.waitForSelector('text=with their takeoff quantities')
  const afterImport = (await jobCall('getJob', [job.id])) as any
  const concrete = afterImport.trades.find((t: any) => t.name === 'Concrete')
  const elec = afterImport.trades.find((t: any) => t.name === 'Electrical')
  if (!concrete || concrete.takeoffLines.length !== 2) throw new Error('Concrete trade not created from the takeoff')
  if (elec.takeoffLines.length !== 3 || elec.bidders.length !== 4) throw new Error('Electrical not updated in place, or Bright Line not added')
  if (concrete.bidders.length !== 3 || !concrete.bidders.some((b: any) => b.email === 'dennis@anchormenllc.com')) throw new Error('vendor list companies not added to Concrete')
  if (concrete.takeoffLines[0].quantity !== 7400) throw new Error('slab quantity not worked out from the drawing: ' + concrete.takeoffLines[0].quantity)
  if (!afterImport.files.some((f: any) => f.name.startsWith('Leopard takeoff - '))) throw new Error('takeoff copy not saved with the job')
  if (![...leo.users.get('estimator@test.local')!.jobs.get('riverside01')!.files.keys()].includes('bidmail-takeoff.json')) throw new Error('takeoff copy not saved in Leopard storage')
  console.log('leopard ok: linked, takeoff imported, trades set up, copies saved in BidMail and Leopard')
  await page.locator('.modal-foot button', { hasText: 'Send request for bids' }).click()
  await page.waitForSelector('.bulk-modal')
  if ((await page.locator('.bt-row input:checked').count()) !== 4) throw new Error('the 4 new companies should be selected')
  await page.locator('.seg button', { hasText: 'Preview' }).click()
  await page.locator('.seg select').selectOption({ label: 'Island Concrete (Concrete)' })
  await page.waitForSelector('.preview-body:has-text("Slab on grade 4\\": 7,400 SF")')
  await page.locator('.seg select').selectOption({ label: 'Bright Line Electric (Electrical)' })
  await page.waitForSelector('.preview-body:has-text("Duplex receptacles: 6 EA")')
  await shot('35-rfb-quantities')
  await page.locator('.modal-foot button', { hasText: 'Cancel' }).click()
  await page.locator('.tabs button', { hasText: 'Takeoff Quantities' }).click()
  await page.waitForSelector('.qty-card')
  await shot('36-takeoff-quantities')

  await app.close()
  await leo.close()
  await new Promise((r) => smtp.close(r))
  await new Promise((r) => imap.close(r))
  await new Promise((r) => imap2.close(r))
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No renderer errors')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})