// Leopard: takeoff analysis, the client against a Leopard-like server, and the import that saves the takeoff
// and sets up trades and request-for-bid emails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { BidStore } from '../src/shared/store'
import { fillTemplate } from '../src/shared/types'
import { mergeFields } from '../src/shared/merge'
import { matchTrade, normalizeTakeoff, packageTakeoff, quantitiesText } from '../src/shared/takeoffAnalysis'
import { leopardQuantity, leopardUnit } from '../src/shared/leopardQuantity'
import { LeopardAuthError, LeopardClient, newLeopardId, safeStoredName } from '../src/main/leopard'
import { LeopardService } from '../src/main/leopardService'
import { BidBackend } from '../src/main/bidBackend'
import { getSettings, publicSettings, saveSettings } from '../src/main/settings'
import { SAMPLE_TAKEOFF, seedLeopard, startMockLeopard } from './mockLeopard'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leopard-')), 'test.db')

test("Leopard's takeoff: quantities worked out as Leopard does, grouped into trades by trade tag or CSI code", () => {
  const lines = normalizeTakeoff(SAMPLE_TAKEOFF)
  assert.equal(lines.length, 7)
  const get = (n: string) => lines.find((l) => l.description.startsWith(n))!
  assert.deepEqual([get('Slab').quantity, get('Slab').unit, get('Slab').sheet, get('Slab').csiCode], [7400, 'SF', 'A-101, A-102', '03 30 00'], 'area less its hole, over two sheets')
  assert.deepEqual([get('Footings').quantity, get('Footings').unit], [1180, 'LF'], 'a typed "1,180" wins; LF from a linear item')
  assert.deepEqual([get('Gyp').quantity, get('Gyp').unit], [850, 'SF'], 'wall area: length x height, the detail at its own scale')
  assert.deepEqual([get('Duplex').quantity, get('Duplex').unit], [6, 'EA'], 'counts count even on a sheet with no scale')
  assert.deepEqual([get('Conduit').quantity, get('Conduit').issue], [null, 'unscaled'])
  assert.deepEqual([get('Misc').quantity, get('Misc').issue], [null, 'unmeasured'])
  assert.equal(get('Slab').itemId, 'i1')

  const pk = packageTakeoff(lines)
  const names = pk.map((p) => p.tradeName)
  assert.ok(names.includes('Concrete') && names.includes('Electrical') && names.includes('Drywall') && names.includes('Unassigned'), names.join(', '))
  const concrete = pk.find((p) => p.tradeName === 'Concrete')!
  assert.equal(concrete.lines.length, 2, 'the slab (trade tag) and the footings (CSI 03 30 00) together')
  assert.deepEqual(concrete.totals.map((t) => t.unit).sort(), ['LF', 'SF'])
  const elec = pk.find((p) => p.tradeName === 'Electrical')!
  assert.deepEqual(elec.totals, [{ unit: 'EA', quantity: 10 }], 'CSI 26 27 26, division 26 and 26 05 33 all go to Electrical')
  assert.equal(elec.lines.length, 3)
  assert.equal(pk.at(-1)!.tradeName, 'Unassigned', 'items with no trade or CSI go last')

  assert.equal(quantitiesText(concrete.lines.slice(0, 1)), '- Slab on grade 4": 7,400 SF (sheet A-101, A-102)')
  assert.equal(quantitiesText([get('Conduit')]), '- Conduit (sheet E-201)', 'no quantity: just the item')
})

test('every kind of Leopard measurement', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const data = (item: any, points: any[], extra: any = {}) => ({ items: [item], sections: [{ id: 's', itemId: item.id, page: 0, points, ...extra }], scales: { 0: { sx: 1, sy: 1 } } })
  const q = (item: any, points: any[] = sq, extra?: any) => leopardQuantity(item, data(item, points, extra))
  assert.equal(q({ id: 'a', kind: 'area' }), 100)
  assert.equal(q({ id: 'a', kind: 'area', measure: 'perimeter' }, sq, { holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]] }), 48, 'perimeter includes the hole')
  assert.equal(q({ id: 'a', kind: 'area', measure: 'volume', depth: 2.7 }), 10, '100 SF x 2.7 ft / 27 = 10 CY')
  assert.equal(Math.round(q({ id: 'a', kind: 'area', measure: 'roofArea', pitch: 12 })! * 1000) / 1000, 141.421, '12/12 pitch')
  assert.equal(q({ id: 'a', kind: 'area', measure: 'wallArea', height: 8 }), 320)
  assert.equal(q({ id: 'l', kind: 'linear', measure: 'wallArea', height: 8, sides: 2 }, [[0, 0], [10, 0]]), 160)
  assert.equal(q({ id: 'l', kind: 'linear', measure: 'dropLength', drop: 3 }, [[0, 0], [10, 0], [10, 5]]), 24, '15 ft + 3 ft drop at each of 3 points')
  assert.equal(q({ id: 'g', kind: 'segment' }, [[0, 0], [3, 4], [10, 10], [10, 0]]), 15, 'two segments: 5 + 10')
  assert.equal(q({ id: 'g', kind: 'segment', measure: 'segments' }, [[0, 0], [3, 4], [10, 10], [10, 0]]), 2)
  assert.equal(q({ id: 'c', kind: 'count', measure: 'cost', price: 25 }, [[1, 1], [2, 2]]), 50)
  assert.equal(q({ id: 'a', kind: 'area', measure: 'cost' }), 100, 'cost needs a price: falls back to the first measure')
  assert.equal(leopardUnit({ kind: 'area', measure: 'volume' }), 'CY')
  assert.equal(leopardUnit({ kind: 'segment', measure: 'segments' }), 'EA')
  assert.equal(leopardUnit({ kind: 'linear', unit: 'LM' }), 'LM', "the item's own unit wins")
  assert.equal(q({ id: 'a', kind: 'area', quantity: 42 }), 42)
  assert.equal(leopardQuantity({ id: 'x', kind: 'area' }, { items: [], sections: [], scales: {} }), null, 'not measured')
})
test("takeoff trades match the job's trades by name, CSI code, or a name that contains the other", () => {
  const trades = [{ name: 'Drywall & Framing', csiCode: '09 21 00' }, { name: 'Electrical', csiCode: '26 00 00' }, { name: 'Painting', csiCode: '' }, { name: 'Wall Painting', csiCode: '' }]
  assert.equal(matchTrade({ tradeName: 'Drywall', csiCode: '' }, trades)?.name, 'Drywall & Framing')
  assert.equal(matchTrade({ tradeName: 'electrical', csiCode: '' }, trades)?.name, 'Electrical')
  assert.equal(matchTrade({ tradeName: 'Power', csiCode: '26 00 00' }, trades)?.name, 'Electrical')
  assert.equal(matchTrade({ tradeName: 'Painting', csiCode: '' }, trades)?.name, 'Painting', 'exact name wins over a longer one')
  assert.equal(matchTrade({ tradeName: 'Framing', csiCode: '' }, trades)?.name, 'Drywall & Framing')
  assert.equal(matchTrade({ tradeName: 'Roofing', csiCode: '' }, trades), undefined)
  assert.equal(matchTrade({ tradeName: 'Unassigned', csiCode: '' }, trades), undefined)
})

test('other takeoff exports (a plain item list with different field names) are read too', () => {
  const lines = normalizeTakeoff({ lines: [{ name: 'Roofing membrane', qty: '24,000', uom: 'sf', division: '07 54 00', page: 'R-1' }, { label: 'Empty' }] })
  assert.deepEqual(lines.map((l) => [l.description, l.quantity, l.unit, l.csiCode, l.sheet]), [
    ['Roofing membrane', 24000, 'SF', '07 54 00', 'R-1'],
    ['Empty', null, '', '', '']
  ])
  assert.equal(packageTakeoff(lines)[0].tradeName, 'Roofing')
})

test('linking a job and applying trade packages: new trades are created, existing ones get their quantities', () => {
  const s = new BidStore(tmp())
  const job = s.call('createJob', [{ name: 'Riverside' }], 'Kei')
  s.call('addTrade', [job.id, { name: 'Electrical', csiCode: '26 00 00' }], 'Kei')
  assert.throws(() => s.call('linkLeopard', [job.id, { projectName: 'x' }], 'Kei'), /Choose a Leopard project/)
  const linked = s.call('linkLeopard', [job.id, { projectId: 'p1', projectName: 'Riverside MOB', url: 'https://leopard.5310s.com/' }], 'Kei')
  assert.equal(linked.leopard.linkedBy, 'Kei')
  assert.equal(linked.leopard.takeoffImportedAt, null)
  const later = s.call('linkLeopard', [job.id, { takeoffImportedAt: '2026-10-30T12:00:00.000Z', itemCount: 6, takeoffPath: 'bidmail-takeoff.json' }], 'Pat')
  assert.deepEqual([later.leopard.projectId, later.leopard.linkedBy, later.leopard.takeoffImportedBy, later.leopard.itemCount], ['p1', 'Kei', 'Pat', 6])

  const packages = packageTakeoff(normalizeTakeoff(SAMPLE_TAKEOFF)).filter((p) => p.tradeName !== 'Unassigned')
  const r = s.call('applyTakeoffPackages', [job.id, packages.map((p) => ({ tradeName: p.tradeName, csiCode: p.csiCode, lines: p.lines }))], 'Pat')
  assert.deepEqual(r, { created: 2, updated: 1 }, 'Electrical matched by CSI; Concrete and Drywall are new')
  const d = s.getJob(job.id)!
  const elec = d.trades.find((t) => t.name === 'Electrical')!
  assert.equal(elec.takeoffLines.length, 3)
  assert.equal(d.trades.find((t) => t.name === 'Concrete')!.takeoffLines[0].unit, 'SF')
  // Re-applying updates instead of duplicating.
  assert.deepEqual(s.call('applyTakeoffPackages', [job.id, packages.map((p) => ({ tradeName: p.tradeName, csiCode: p.csiCode, lines: p.lines }))], 'Pat'), { created: 0, updated: 3 })
  assert.equal(s.getJob(job.id)!.trades.length, 3)
  const audit = s.listAudit(job.id).map((a) => a.summary)
  assert.ok(audit.some((a) => /Set up 3 trade/.test(a)), audit.join(' | '))
  assert.ok(audit.some((a) => /Linked to Leopard project "Riverside MOB"/.test(a)))

  // {{takeoff_quantities}} in a request-for-bid email.
  const f = mergeFields(d.job, elec, { contactName: 'Mike', companyName: 'ABC Electric', email: 'a@b.c' } as any, { name: 'Kei', company: 'Acme' })
  const html = fillTemplate('<p>{{takeoff_quantities}}</p>', f, true)
  assert.match(html, /Quantities from our takeoff.*<br>- Duplex receptacles: 6 EA \(sheet E-201\)<br>- Light fixtures type A: 4 EA \(sheet E-201\)<br>- Conduit \(sheet E-201\)/)
  const none = mergeFields(d.job, { ...elec, takeoffLines: [] }, { contactName: '', companyName: 'X', email: '' } as any, { name: '', company: '' })
  assert.equal(fillTemplate('{{takeoff_quantities}}', none, true), '')

  assert.equal(s.call('linkLeopard', [job.id, null], 'Kei').leopard, null)
})

test('Leopard client: cookie sign-in, Origin on changes, projects, takeoff, storage and errors', async () => {
  const m = await startMockLeopard()
  try {
    const { email, password } = seedLeopard(m)
    const c = new LeopardClient(m.url)
    await assert.rejects(() => c.login(email, 'wrong'), /Wrong email or password/)
    await assert.rejects(() => c.projects(), LeopardAuthError)
    const me = await c.login(email.toUpperCase(), password)
    assert.equal(me.email, email)
    assert.equal(me.quotaBytes, 10 * 1024 ** 3)
    assert.ok(me.usedBytes! > 2048)
    assert.ok(c.cookie.length > 10)
    const login = m.requests.find((r) => r.path === '/api/login' && r.method === 'POST')!
    assert.equal(login.origin, new URL(m.url).origin, 'Leopard checks Origin on POST')

    const projects = await c.projects()
    assert.deepEqual(projects.map((p) => p.name), ['Riverside Medical Office', 'County Library Reroof'], 'most recently changed first')
    assert.equal(projects[0].fileCount, 1)
    assert.ok(projects[0].takeoffSaved)

    const t = await c.takeoff('riverside01')
    assert.equal(t.data.items.length, 7)
    assert.ok(t.saved && t.saved > 0)
    assert.deepEqual(await c.takeoff('library01'), { data: null, saved: null })

    assert.equal(safeStoredName('bidmail takeoff 2026-10-30 1200.json'), 'bidmail-takeoff-2026-10-30-1200.json')
    const stored = await c.putFile('riverside01', 'bidmail takeoff.json', '{"a":1}', 'application/json')
    assert.equal(m.users.get(email)!.jobs.get('riverside01')!.files.get(stored)!.toString(), '{"a":1}')

    assert.match(newLeopardId(), /^[a-z0-9]{4,40}$/)
    assert.equal(c.projectUrl('riverside01', 'i3'), m.url + '/?job=riverside01&item=i3')
    const created = await c.createProject({ name: 'New School', number: '25-001' }, email)
    assert.match(created.id, /^[a-z0-9]{4,40}$/, 'an id Leopard accepts')
    assert.equal(m.users.get(email)!.jobs.get(created.id)!.job.name, 'New School')

    m.quota = 100
    await assert.rejects(() => c.putFile('riverside01', 'big.bin', Buffer.alloc(500)), /storage is full/)

    await c.logout()
    const stale = new LeopardClient(m.url, 'expired-cookie')
    await assert.rejects(() => stale.me(), /sign-in has expired/)
  } finally {
    await m.close()
  }
})

test('importing a takeoff saves a copy with the job and in Leopard storage, then sets up trades', async () => {
  const m = await startMockLeopard()
  const backend = new BidBackend(() => 'Kei', () => {}, () => {})
  try {
    const { email, password } = seedLeopard(m)
    await backend.configure({ mode: 'local', url: '', key: '', port: 0 } as any)
    const svc = new LeopardService(backend)
    assert.equal((await svc.status()).signedIn, false)
    await assert.rejects(() => svc.login(m.url, email, ''), /Enter your Leopard email and password/)
    const st = await svc.login(m.url, email, password)
    assert.equal(st.signedIn, true)
    assert.equal(st.email, email)
    assert.ok(getSettings().leopard.cookie, 'cookie kept')
    assert.equal(publicSettings().leopard.cookie, '(signed in)', 'never shown to the screens')
    saveSettings({ leopard: { ...publicSettings().leopard } })
    assert.notEqual(getSettings().leopard.cookie, '(signed in)', 'saving other settings keeps the real cookie')

    const job = await backend.call('createJob', [{ name: 'Riverside Medical Office', number: '24-117' }])
    await assert.rejects(() => svc.importTakeoff(job.id), /Link this job/)
    await svc.link(job.id, 'library01')
    await assert.rejects(() => svc.importTakeoff(job.id), /has no saved takeoff/)
    await svc.link(job.id, 'riverside01')

    const r = await svc.importTakeoff(job.id)
    assert.equal(r.itemCount, 7)
    assert.equal(r.missingQuantities, 2)
    assert.ok(r.warnings.some((w) => /1 item\(s\) are measured only on sheets with no scale/.test(w)), r.warnings.join(' | '))
    assert.ok(r.warnings.some((w) => /1 item\(s\) aren't measured yet/.test(w)))
    assert.equal(r.packages.find((p) => p.tradeName === 'Concrete')!.lines[0].quantity, 7400)
    assert.ok(r.leopardFile && /^bidmail-takeoff-.*\.json$/.test(r.leopardFile), String(r.leopardFile))
    const saved = JSON.parse(m.users.get(email)!.jobs.get('riverside01')!.files.get(r.leopardFile!)!.toString())
    assert.equal(saved.app, 'BidMail')
    assert.ok(saved.packages.some((p: any) => p.trade === 'Concrete'))

    let d = await backend.call('getJob', [job.id])
    assert.deepEqual(d.files.map((f: any) => f.name.replace(/\d{4}-\d\d-\d\d \d{4}/, 'DATE')).sort(), ['Leopard takeoff - DATE quantities.csv', 'Leopard takeoff - DATE.json'])
    assert.equal(d.job.leopard.itemCount, 7)
    assert.equal(d.job.leopard.url, m.url + '/?job=riverside01')
    assert.equal(d.job.leopard.takeoffImportedBy, 'Kei')
    assert.equal(d.job.takeoff.assignee, 'Kei', "Leopard's estimator becomes the takeoff assignee")
    assert.equal(d.job.takeoff.status, 'in_progress')

    // Re-import replaces the copy instead of piling up files.
    await svc.importTakeoff(job.id)
    d = await backend.call('getJob', [job.id])
    assert.equal(d.files.length, 2)

    const chosen = r.packages.filter((p) => p.tradeName !== 'Unassigned')
    const applied = await backend.call('applyTakeoffPackages', [job.id, chosen.map((p) => ({ tradeName: p.tradeName, csiCode: p.csiCode, lines: p.lines }))])
    assert.deepEqual(applied, { created: 3, updated: 0 })

    // A project created from the job is linked right away.
    const job2 = await backend.call('createJob', [{ name: 'Fire Station 3', number: '25-010', location: 'Shelbyville' }])
    const linked = await svc.createProject(job2.id)
    assert.equal(linked.leopard.projectName, 'Fire Station 3')
    assert.equal([...m.users.get(email)!.jobs.values()].find((j) => j.job.name === 'Fire Station 3')!.job.location, 'Shelbyville')

    // An expired Leopard sign-in clears the saved cookie so BidMail asks again.
    m.sessions.clear()
    await assert.rejects(() => svc.projects(), /sign-in has expired/)
    assert.equal(getSettings().leopard.cookie, '')
    assert.equal((await svc.status()).signedIn, false)
  } finally {
    await backend.configure({ mode: 'local', url: '', key: '', port: 0 } as any).catch(() => {})
    await m.close()
  }
})