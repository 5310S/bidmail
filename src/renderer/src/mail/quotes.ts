// Shows each email as what its sender wrote at that time: the older emails quoted under a reply (Outlook's
// "From: / Sent: / To: / Subject:" block, Gmail and Apple Mail quotes, "-----Original Message-----", "On ... wrote:")
// are cut off and offered behind a "Show earlier emails" button. Forwards are left whole: the forwarded email is
// what was sent. Nothing is cut when it would leave the email empty.

const HEADER_START = /^\s*(from|de|von|van|da)\s*:\s*\S/i
const HEADER_REST = /(^|\n)\s*(sent|date|envoyé|gesendet|datum)\s*:|(^|\n)\s*subject\s*:/i
const ORIGINAL = /^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}/i
const WROTE = /^\s*on\s.{6,220}\swrote:?\s*$/i

const isForward = (subject: string) => /^\s*(fw|fwd)\s*:/i.test(subject)

/** An Outlook-style header block: "From: ..." followed closely by "Sent:"/"Date:" or "Subject:". */
function headerBlock(text: string): boolean {
  if (!HEADER_START.test(text)) return false
  return HEADER_REST.test(text.slice(0, 700))
}

/** Plain text: everything from the first quote marker on is the quoted chain. */
export function splitTextQuote(text: string, subject = ''): { main: string; quoted: boolean } {
  if (!text || isForward(subject)) return { main: text, quoted: false }
  const lines = text.split(/\r?\n/)
  let cut = -1
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const l = lines[i]
    const next = lines.slice(i, i + 8).join('\n')
    if (ORIGINAL.test(l) || WROTE.test(l) || (HEADER_START.test(l) && headerBlock(next))) cut = i
    else if (/^\s*_{8,}\s*$/.test(l) && headerBlock(lines.slice(i + 1, i + 9).join('\n'))) cut = i
    else if (/^>/.test(l) && lines.slice(i, i + 3).filter((x) => /^>/.test(x)).length >= 2) cut = i
  }
  if (cut <= 0) return { main: text, quoted: false }
  const main = lines.slice(0, cut).join('\n').replace(/\s+$/, '')
  return main.trim() ? { main, quoted: true } : { main: text, quoted: false }
}

/** Where the quoted chain starts in an HTML email, or null. */
function boundary(body: HTMLElement): Element | null {
  const found: Element[] = []
  // Markers the mail programs put on their own quotes.
  const marked = body.querySelector(
    '#divRplyFwdMsg, #appendonsend, div.OutlookMessageHeader, #mail-editor-reference-message-container, div.gmail_quote, blockquote.gmail_quote, blockquote[type="cite"], .yahoo_quoted, .moz-cite-prefix, #isForwardContent, .zmail_extra'
  )
  if (marked) found.push(marked.id === 'appendonsend' ? (marked.nextElementSibling ?? marked) : marked)
  // Outlook's header block ("From: / Sent: / To: / Subject:"), however it is wrapped, and its older plain separators.
  for (const el of Array.from(body.querySelectorAll('div, p, span, font, b, table, td'))) {
    const t = (el.textContent ?? '').replace(/ /g, ' ')
    if (headerBlock(t) || ORIGINAL.test(t) || (WROTE.test(t.split('\n')[0] ?? '') && t.length < 300)) {
      found.push(el)
      break
    }
  }
  if (!found.length) return null
  found.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  return found[0]
}

/** HTML: the email up to where the quoted chain starts. Parsing with DOMParser runs no scripts and loads nothing. */
export function splitHtmlQuote(html: string, subject = ''): { main: string; quoted: boolean } {
  if (!html || isForward(subject) || typeof DOMParser === 'undefined') return { main: html, quoted: false }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body
  const cut = boundary(body)
  if (!cut || cut === body) return { main: html, quoted: false }
  // The line Outlook draws above its header block goes too.
  let before = cut.previousElementSibling
  while (before && !(before.textContent ?? '').trim() && before.tagName !== 'HR' && !before.querySelector('img')) before = before.previousElementSibling
  if (before?.tagName === 'HR') before.remove()
  // Remove the quote and everything after it, at every level up to the body.
  let cur: Node | null = cut
  while (cur && cur !== body) {
    while (cur.nextSibling) cur.nextSibling.remove()
    cur = cur.parentNode
  }
  cut.remove()
  if (!(body.textContent ?? '').trim() && !body.querySelector('img')) return { main: html, quoted: false }
  return { main: doc.documentElement.outerHTML, quoted: true }
}
