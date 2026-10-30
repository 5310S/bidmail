// Leopard's own check of its quantity math (Leopard commit 36480e7, tests/fixtures/bidmail-quantities.json, math at
// 5692cde): every kind, measure, layout and scale case, with the value Leopard gives. BidMail must give the same.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fixture from './fixtures/leopard-quantities.json'
import { itemMeasure, leopardQuantity, leopardUnit, measuredQuantity } from '../src/shared/leopardQuantity'
import { normalizeTakeoff, quantitiesText } from '../src/shared/takeoffAnalysis'

const data: any = fixture.takeoff
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9 * Math.abs(b), 1e-12)

test("BidMail's quantities equal Leopard's for all 31 cases", () => {
  assert.equal(fixture.leopardCommit, '5692cde')
  assert.equal(fixture.answers.length, 31)
  for (const a of fixture.answers as any[]) {
    const item = data.items.find((i: any) => i.id === a.id)
    assert.equal(itemMeasure(item), a.measure, `${a.id} measure`)
    assert.equal(leopardUnit(item), a.unit, `${a.id} unit`)
    const m = measuredQuantity(data, item)
    assert.ok(close(m.value, a.value), `${a.id} value: BidMail ${m.value}, Leopard ${a.value}`)
    assert.equal(m.unscaled, a.unscaled, `${a.id} unscaled sections`)
    // The quantity shown: Leopard's total, except where BidMail says why there's none.
    const q = leopardQuantity(item, data)
    if (typeof a.total === 'string') assert.equal(q, null, `${a.id}: typed text`)
    else if (['n1', 'u1', 'r2'].includes(a.id)) assert.equal(q, null, `${a.id}: nothing to measure`)
    else assert.ok(q !== null && close(q, a.total), `${a.id} total: BidMail ${q}, Leopard ${a.total}`)
  }
})

test("Leopard's cases as BidMail lines: why there's no quantity, typed text, sheet names", () => {
  const lines = normalizeTakeoff(data)
  const line = (id: string) => lines.find((l) => l.itemId === id)!
  assert.equal(lines.length, 31)
  assert.deepEqual([line('n1').quantity, line('n1').issue], [null, 'unmeasured'], 'nothing drawn')
  assert.deepEqual([line('u1').quantity, line('u1').issue], [null, 'unscaled'], 'only on an unscaled sheet')
  assert.deepEqual([line('r2').quantity, line('r2').issue], [null, 'unscaled'], 'in an unscaled detail: no fallback to the sheet')
  assert.deepEqual([line('t1').quantity, line('t1').quantityText, line('t1').issue], [null, 'LS', ''], 'typed text wins')
  assert.equal(line('t2').quantity, 42)
  assert.equal(line('l1').quantity, 44.907119849998594, 'the scaled sheet only')
  assert.deepEqual([line('m4').quantity, line('m4').unit], [225, 'LS'], 'a hand-set unit is only a label')
  assert.equal(line('r1').sheet, 'A-501')
  assert.equal(line('b1').sheet, 'A-101 (old)', 'binned sheets count, as in Leopard')
  assert.equal(line('c1').sheet, 'A-101, A-102')
  assert.equal(quantitiesText([line('t1')]), '- Typed text quantity: LS')
  assert.deepEqual([line('a8').isCost, line('c2').isCost, line('a1').isCost], [true, true, undefined])
  assert.equal(quantitiesText([line('a1'), line('a8'), line('c2')]), '- Area with a hole: 413.9 SF (sheet A-101)', 'costs never go in a request for bids')
})