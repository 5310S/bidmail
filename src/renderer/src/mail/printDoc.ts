import type { MessageDetail } from '../../../shared/ipc'
import { escapeHtml } from '../../../shared/types'
import { addrText, fmtFullDate, fmtSize } from '../util'
import { sanitizeEmail, textToHtml } from './sanitize'

export const PRINT_CSS = `
  @page { margin: 0.5in; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Calibri, Arial, sans-serif; font-size: 11pt; color: #111; margin: 0; }
  .bm-print-head { border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 16px; }
  .bm-print-head h1 { font-size: 16pt; margin: 0 0 8px; }
  .bm-print-head table { border-collapse: collapse; font-size: 10pt; }
  .bm-print-head td { padding: 1px 10px 1px 0; vertical-align: top; }
  .bm-print-head td:first-child { color: #555; font-weight: 600; white-space: nowrap; }
  .bm-print-body img { max-width: 100%; height: auto; }
  .bm-print-body table { max-width: 100%; }
  .bm-plain { white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; }
  a { color: #1f5fbf; }
`

/** Builds a self-contained, sanitized HTML document for printing or saving an email as PDF. */
export function buildPrintDoc(m: MessageDetail, allowImages: boolean): string {
  let styles = ''
  let body: string
  if (m.html) {
    const doc = new DOMParser().parseFromString(sanitizeEmail(m.html, allowImages).html, 'text/html')
    styles = [...doc.querySelectorAll('style')].map((s) => s.outerHTML).join('')
    doc.querySelectorAll('style').forEach((s) => s.remove())
    body = doc.body.innerHTML
  } else {
    body = `<div class="bm-plain">${textToHtml(m.text)}</div>`
  }
  const rows: [string, string][] = [
    ['From', addrText(m.from)],
    ['Date', fmtFullDate(m.date)],
    ['To', addrText(m.to)]
  ]
  if (m.cc.length) rows.push(['Cc', addrText(m.cc)])
  if (m.attachments.length) rows.push(['Attachments', m.attachments.map((a) => `${a.filename} (${fmtSize(a.size)})`).join(', ')])
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(m.subject)}</title>` +
    `<style>${PRINT_CSS}</style>${styles}</head><body>` +
    `<div class="bm-print-head"><h1>${escapeHtml(m.subject)}</h1><table>` +
    rows.map(([k, v]) => `<tr><td>${k}:</td><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table></div><div class="bm-print-body">${body}</div></body></html>`
  )
}