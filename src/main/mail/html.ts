// Small HTML helpers for outgoing mail.

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  - ')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const l = String(label).replace(/<[^>]+>/g, '').trim()
      return l && l !== href ? `${l} (${href})` : href
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Wraps a body fragment in a minimal, widely compatible HTML document. */
export function wrapHtml(body: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
    '<body style="font-family: Calibri, Arial, Helvetica, sans-serif; font-size: 11pt; color: #222;">' +
    body +
    '</body></html>'
  )
}