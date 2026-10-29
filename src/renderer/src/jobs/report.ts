// Printable bid status report for a job: every trade, every company, every checkpoint with date/time.
import { BIDDER_STAGE_LABELS, bidderStage, effectiveTradeStatus, escapeHtml, JobDetail, TRADE_STATUS_LABELS } from '../../../shared/types'
import { formatBidDue } from '../../../shared/merge'
import { fmtDateTime, fmtMoney } from '../util'
import { PRINT_CSS } from '../mail/printDoc'

export function buildJobReport(d: JobDetail, me: { name: string; company: string }): string {
  const e = (s: string | null | undefined) => escapeHtml(s ?? '')
  const j = d.job
  const bidders = d.trades.flatMap((t) => t.bidders)
  const lowTotal = d.trades.reduce((s, t) => {
    const p = t.bidders.filter((b) => b.priceAmount != null).map((b) => b.priceAmount!)
    return s + (p.length ? Math.min(...p) : 0)
  }, 0)
  const trades = d.trades
    .map((t) => {
      const st = TRADE_STATUS_LABELS[effectiveTradeStatus(t)]
      const priced = t.bidders.filter((b) => b.priceAmount != null)
      const low = priced.length ? Math.min(...priced.map((b) => b.priceAmount!)) : null
      const rows = t.bidders.length
        ? t.bidders
            .map((b) => {
              const isLow = low != null && b.priceAmount === low && priced.length > 1
              return `<tr${isLow ? ' class="low"' : ''}><td><b>${e(b.companyName)}</b><div class="sub">${e([b.contactName, b.email, b.phone].filter(Boolean).join(' · '))}</div></td>
                <td>${e(fmtDateTime(b.drawingsSentAt))}</td>
                <td>${b.followUpCount ? `${b.followUpCount}× · ${e(fmtDateTime(b.lastFollowUpAt))}` : ''}</td>
                <td class="num">${b.priceReceivedAt ? `${b.priceAmount != null ? e(fmtMoney(b.priceAmount)) : 'Received'}<div class="sub">${e(fmtDateTime(b.priceReceivedAt))}</div>` : ''}</td>
                <td>${e(BIDDER_STAGE_LABELS[bidderStage(b)])}</td></tr>`
            })
            .join('')
        : '<tr><td colspan="5" class="sub">No companies yet</td></tr>'
      return `<h2>${e(t.name)} <span class="sub">${e(t.csiCode)} · ${e(st)} · ${priced.length}/${t.bidders.length} priced${low != null ? ` · low ${e(fmtMoney(low))}` : ''}</span></h2>
        <table><thead><tr><th>Company</th><th>Drawings sent</th><th>Follow-ups</th><th class="num">Price</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
    })
    .join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${e(j.name)} - Bid Status</title><style>${PRINT_CSS}
    h1 { font-size: 18pt; margin: 0; } h2 { font-size: 12pt; margin: 18px 0 6px; page-break-after: avoid; }
    .sub { color: #666; font-size: 9pt; font-weight: normal; }
    .facts { display: flex; gap: 24px; margin: 8px 0 4px; font-size: 10pt; }
    table { width: 100%; border-collapse: collapse; font-size: 9.5pt; page-break-inside: auto; table-layout: fixed; }
    th:nth-child(1) { width: 36%; } th:nth-child(2) { width: 17%; } th:nth-child(3) { width: 17%; } th:nth-child(4) { width: 15%; } th:nth-child(5) { width: 15%; }
    th { text-align: left; border-bottom: 1.5px solid #333; padding: 4px 6px; font-size: 8.5pt; text-transform: uppercase; color: #444; }
    td { border-bottom: 1px solid #ddd; padding: 4px 6px; vertical-align: top; }
    tr { page-break-inside: avoid; } tr.low td { background: #e7f5ec; } .num { text-align: right; white-space: nowrap; }
  </style></head><body>
    <div class="bm-print-head"><h1>${e(j.name)}</h1>
      <div class="sub">${e([j.number && '#' + j.number, j.client, j.location].filter(Boolean).join(' · '))}</div>
      <div class="facts"><span><b>Bids due:</b> ${e(formatBidDue(j.bidDue) || 'Not set')}</span>
        <span><b>Companies:</b> ${bidders.length}</span><span><b>Invited:</b> ${bidders.filter((b) => b.drawingsSentAt).length}</span>
        <span><b>Prices in:</b> ${bidders.filter((b) => b.priceReceivedAt).length}</span><span><b>Total of low prices:</b> ${e(fmtMoney(lowTotal) || '$0')}</span></div>
      <div class="sub">Printed ${e(new Date().toLocaleString('en-US'))}${me.name ? ' by ' + e(me.name) : ''}${me.company ? ', ' + e(me.company) : ''}</div>
    </div>${trades}</body></html>`
}