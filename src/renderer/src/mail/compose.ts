import type { MailAccount, MessageDetail } from '../../../shared/ipc'
import { escapeHtml } from '../../../shared/types'
import { addrText, fmtFullDate } from '../util'
import { sanitizeEmail, textToHtml } from './sanitize'
import type { ComposeInit } from '../state'

const prefix = (p: string, s: string) => (new RegExp('^\\s*' + p + ':', 'i').test(s) ? s : `${p}: ${s}`)

function quotedBody(m: MessageDetail) {
  const body = m.html ? sanitizeEmail(m.html, false).html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<\/?(html|head|body)[^>]*>/gi, '') : textToHtml(m.text).replace(/\n/g, '<br>')
  return body
}

export function replyInit(m: MessageDetail, folder: string, accountId: string, me: MailAccount | undefined, all: boolean): ComposeInit {
  const mine = (me?.email ?? '').toLowerCase()
  const primary = m.replyTo.length ? m.replyTo : m.from
  let to = primary
  let cc: typeof to = []
  if (all) {
    const seen = new Set(primary.map((a) => a.address.toLowerCase()))
    to = [...primary, ...m.to.filter((a) => !seen.has(a.address.toLowerCase()) && a.address.toLowerCase() !== mine)]
    const seen2 = new Set(to.map((a) => a.address.toLowerCase()))
    cc = m.cc.filter((a) => !seen2.has(a.address.toLowerCase()) && a.address.toLowerCase() !== mine)
  }
  const who = escapeHtml(addrText(m.from))
  return {
    heading: all ? 'Reply All' : 'Reply',
    accountId,
    to: addrText(to),
    cc: addrText(cc),
    subject: prefix('Re', m.subject),
    html: `<p><br></p><div class="bm-quote"><p>On ${escapeHtml(fmtFullDate(m.date))}, ${who} wrote:</p><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${quotedBody(m)}</blockquote></div>`,
    inReplyTo: m.messageId,
    references: [...m.references, m.messageId].filter(Boolean),
    answered: { path: folder, uid: m.uid },
    attachments: []
  }
}

export function forwardInit(m: MessageDetail, accountId: string): ComposeInit {
  const rows = [
    ['From', addrText(m.from)],
    ['Date', fmtFullDate(m.date)],
    ['Subject', m.subject],
    ['To', addrText(m.to)],
    ...(m.cc.length ? [['Cc', addrText(m.cc)]] : [])
  ]
  const head = rows.map(([k, v]) => `<b>${k}:</b> ${escapeHtml(v)}`).join('<br>')
  return {
    heading: 'Forward',
    accountId,
    to: '',
    cc: '',
    subject: prefix('Fwd', m.subject),
    html: `<p><br></p><div class="bm-quote"><p>---------- Forwarded message ----------<br>${head}</p>${quotedBody(m)}</div>`,
    attachments: m.attachments.map((a) => ({ filename: a.filename, size: a.size, source: { key: m.key, id: a.id } }))
  }
}