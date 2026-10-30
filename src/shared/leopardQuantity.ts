// Quantities for Leopard takeoff items. Leopard doesn't store quantities: it computes them from the points
// measured on each page and that page's scale. BidMail mirrors that math so its numbers match Leopard's estimate.
import type { QuantityFn } from './takeoffAnalysis'

export const leopardQuantity: QuantityFn = (item) => {
  const q = item?.quantity
  if (q == null || q === '') return null
  const n = Number(String(q).replace(/[,\s]/g, ''))
  return isNaN(n) ? null : n
}