// The vendor list (Excel) and choosing the companies that get each trade's request for bids.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { readXlsx } from '../src/main/xlsx'
import { companiesForTrade, csvRows, parseVendorList, tradeCovers } from '../src/shared/vendorList'
import { BidStore } from '../src/shared/store'
import { makeXlsx, VENDOR_ROWS } from './xlsxFixture'

test('an Excel vendor list is read: title, header row, companies with trades, types and contacts', () => {
  const sheets = readXlsx(makeXlsx(VENDOR_ROWS, 'Vendors'))
  assert.equal(sheets[0].name, 'Vendors')
  assert.equal(sheets[0].rows[2][1], 'Company Name')
  assert.equal(sheets[0].rows[3][3], '6319811234', 'numbers come back as text')
  const r = parseVendorList(sheets[0].rows)
  assert.equal(r.title, 'Riverside MOB')
  assert.equal(r.companies.length, 8)
  assert.equal(r.skipped, 1, 'a company with no email or phone is skipped')
  const anchor = r.companies.find((c) => c.name === 'Anchormen')!
  assert.deepEqual([anchor.email, anchor.trades, anchor.union, anchor.contactName, anchor.notes], ['dennis@anchormenllc.com', 'Concrete, Excavation', 'union', 'Dennis', 'Apprentice program: Yes'])
  assert.equal(r.companies.find((c) => c.name === 'Island Concrete')!.certifications, 'MBE, DBE')
  assert.equal(r.companies.find((c) => c.name.startsWith('Cornerstone'))!.name, 'Cornerstone Restoration', 'trimmed')
  assert.throws(() => parseVendorList([['Hello'], ['World']]), /header row/)
  assert.deepEqual(csvRows('Company,Email\r\n"Smith, Inc",a@b.com\n'), [['Company', 'Email'], ['Smith, Inc', 'a@b.com']])
})

test('takeoff trades find their companies by Category, including combined categories and typos', () => {
  const list = parseVendorList(readXlsx(makeXlsx(VENDOR_ROWS))[0].rows).companies.map((c) => ({ name: c.name!, trades: c.trades!, email: c.email! }))
  const names = (t: string, csi = '') => companiesForTrade(list, t, csi).map((c) => c.name).sort()
  assert.deepEqual(names('Concrete'), ['Anchormen', 'Cornerstone Restoration', 'Island Concrete'], 'not the polished-concrete company')
  assert.deepEqual(names('Cast-in-Place Concrete'), ['Anchormen', 'Cornerstone Restoration', 'Island Concrete'])
  assert.deepEqual(names('Doors, Frames & Hardware'), ['Arch Mills'])
  assert.deepEqual(names('Drywall & Framing'), ['Ortiz Drywall'])
  assert.deepEqual(names('Power', '26 00 00'), ['ABC Electric', 'Bright Line Electric'], 'by the CSI code when the name says nothing')
  assert.deepEqual(names('Roofing'), [])
  assert.ok(tradeCovers('Store Front', 'Storefront & Curtain Wall'))
  assert.ok(tradeCovers('Demo', 'Demolition'))
  assert.ok(tradeCovers('Site Work', 'Earthwork & Sitework'))
  assert.ok(tradeCovers('Partitions', 'Toilet Partitions & Accessories'))
  assert.ok(!tradeCovers('Polished Concrete', 'Concrete'))
  assert.ok(!tradeCovers('Metal Works', 'Misc. Metals'))
})

test('setting up trades adds the chosen companies once, with their contact details', () => {
  const s = new BidStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vendors-')), 't.db'))
  s.importCompanies(parseVendorList(readXlsx(makeXlsx(VENDOR_ROWS))[0].rows).companies)
  const cos = s.listCompanies()
  const id = (n: string) => cos.find((c) => c.name === n)!.id
  const job = s.call('createJob', [{ name: 'Riverside' }], 'Kei')
  const elec = s.call('addTrade', [job.id, { name: 'Electrical' }], 'Kei')
  s.call('addBidder', [elec.id, { companyName: 'ABC Electric', email: 'MIKE@abc-electric.com' }], 'Kei')
  const lines = [{ description: 'Receptacles', quantity: 6, unit: 'EA', sheet: 'E-201' }]
  const r = s.call('applyTakeoffPackages', [job.id, [
    { tradeName: 'Concrete', csiCode: '03 30 00', lines, companyIds: [id('Island Concrete'), id('Anchormen')] },
    { tradeName: 'Electrical', csiCode: '26 00 00', lines, companyIds: [id('ABC Electric'), id('Bright Line Electric')] }
  ]], 'Kei')
  assert.deepEqual(r, { created: 1, updated: 1, companies: 3 }, 'ABC Electric was already on Electrical (same email)')
  const d = s.getJob(job.id)!
  const concrete = d.trades.find((t) => t.name === 'Concrete')!
  assert.deepEqual(concrete.bidders.map((b) => [b.companyName, b.contactName, b.email, b.phone]).sort(), [
    ['Anchormen', 'Dennis', 'dennis@anchormenllc.com', '(631) 242-1102'],
    ['Island Concrete', '', 'estimating@islandconcrete.com', '6319811234']
  ])
  assert.equal(concrete.bidders[0].companyId !== null, true)
  assert.equal(d.trades.find((t) => t.name === 'Electrical')!.bidders.length, 2)
  // Again: nobody is added twice.
  assert.equal(s.call('applyTakeoffPackages', [job.id, [{ tradeName: 'Concrete', csiCode: '', lines, companyIds: [id('Island Concrete')] }]], 'Kei').companies, 0)
  assert.ok(s.listAudit(job.id).some((a) => /with 4 companies from the vendor list/.test(a.summary)))
})