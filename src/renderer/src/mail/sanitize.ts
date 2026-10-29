import DOMPurify from 'dompurify'

export interface SanitizedHtml {
  html: string
  blockedImages: number
}

/** Cleans incoming email HTML. Remote images are blocked (tracking pixels) unless allowed. */
export function sanitizeEmail(html: string, allowRemote: boolean): SanitizedHtml {
  let blocked = 0
  const purify = DOMPurify()
  purify.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (!allowRemote) {
      const src = node.getAttribute('src')
      if (src && /^\s*(https?:)?\/\//i.test(src)) {
        node.setAttribute('data-blocked-src', src)
        node.removeAttribute('src')
        node.removeAttribute('srcset')
        blocked++
      }
      const bg = node.getAttribute('background')
      if (bg && /^\s*(https?:)?\/\//i.test(bg)) {
        node.removeAttribute('background')
        blocked++
      }
      const style = node.getAttribute('style')
      if (style && /url\(\s*["']?\s*(https?:)?\/\//i.test(style)) {
        node.setAttribute('style', style.replace(/url\(\s*["']?\s*(https?:)?\/\/[^)]*\)/gi, 'none'))
        blocked++
      }
    }
  })
  purify.addHook('uponSanitizeElement', (node: Node, data: { tagName: string }) => {
    if (data.tagName === 'style' && !allowRemote && node.textContent && /url\(\s*["']?\s*(https?:)?\/\//i.test(node.textContent)) {
      node.textContent = node.textContent.replace(/url\(\s*["']?\s*(https?:)?\/\/[^)]*\)/gi, 'none')
      blocked++
    }
  })
  const clean = purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'bgcolor', 'background', 'align', 'valign', 'cellpadding', 'cellspacing', 'border', 'width', 'height'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick']
  }) as unknown as string
  return { html: clean, blockedImages: blocked }
}

/** Converts plain text to safe HTML with clickable links. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(/\b(https?:\/\/[^\s<>"')]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
}

/** Rough plain-text rendering of HTML for the "simple view" reading mode. */
export function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(DOMPurify.sanitize(html), 'text/html')
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'))
  doc.querySelectorAll('p, div, tr, li, h1, h2, h3, h4, blockquote').forEach((el) => el.append('\n'))
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (/^https?:/i.test(href) && a.textContent?.trim() !== href) a.append(` (${href})`)
  })
  return (doc.body.textContent ?? '').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}