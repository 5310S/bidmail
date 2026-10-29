import { useEffect, useMemo, useRef, useState } from 'react'
import { sanitizeEmail, textToHtml, htmlToPlain } from './sanitize'
import { sys } from '../api'
import { useApp } from '../state'

const BASE_CSS = (fontSize: number) => `
  html { zoom: ${(fontSize / 15).toFixed(3)}; }
  body { margin: 0; padding: 4px 2px 24px; font-family: system-ui, -apple-system, "Segoe UI", Calibri, "Helvetica Neue", Arial, sans-serif; font-size: 15px;
         line-height: 1.55; color: #1d232b; background: #fff; word-wrap: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  a { color: #1f5fbf; }
  blockquote { margin: 0 0 0 .8ex; border-left: 2px solid #c9d1dc; padding-left: 1ex; color: #44505e; }
  img:not([src]) { display: none; }
`

/** Renders an email safely: HTML in a script-free sandboxed iframe, plain text as escaped HTML. */
export function MessageBody({
  html, text, allowImages, simple, fontSize, onBlocked
}: {
  html: string
  text: string
  allowImages: boolean
  simple: boolean
  fontSize: number
  onBlocked: (n: number) => void
}) {
  const { compose } = useApp()
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(200)

  const doc = useMemo(() => {
    if (simple || !html) {
      const plain = simple && html ? htmlToPlain(html) : text
      return { html: '', blocked: 0, plain }
    }
    const s = sanitizeEmail(html, allowImages)
    const withCss = s.html.includes('</head>')
      ? s.html.replace('</head>', `<style>${BASE_CSS(fontSize)}</style></head>`)
      : `<html><head><style>${BASE_CSS(fontSize)}</style></head><body>${s.html}</body></html>`
    return { html: withCss, blocked: s.blockedImages, plain: '' }
  }, [html, text, allowImages, simple, fontSize])

  useEffect(() => onBlocked(doc.blocked), [doc.blocked, onBlocked])

  const handleLink = (href: string) => {
    if (/^mailto:/i.test(href)) {
      const u = new URL(href)
      compose({ to: decodeURIComponent(u.pathname), subject: u.searchParams.get('subject') ?? '' })
    } else if (/^https?:/i.test(href)) sys.openExternal(href)
  }

  useEffect(() => {
    const frame = ref.current
    if (!frame || !doc.html) return
    let ro: ResizeObserver | null = null
    const onLoad = () => {
      const d = frame.contentDocument
      if (!d) return
      const measure = () => setHeight(Math.max(120, Math.ceil(d.documentElement.scrollHeight * 1)))
      measure()
      ro = new ResizeObserver(measure)
      ro.observe(d.documentElement)
      d.addEventListener('click', (e) => {
        const a = (e.target as Element).closest?.('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href')
        if (href) handleLink(href)
      })
    }
    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.html])

  if (!doc.html) {
    return (
      <div
        className="plain-body"
        style={{ fontSize }}
        onClick={(e) => {
          const a = (e.target as Element).closest('a')
          if (a) {
            e.preventDefault()
            handleLink(a.getAttribute('href') ?? '')
          }
        }}
        dangerouslySetInnerHTML={{ __html: textToHtml(doc.plain || '(This message has no text.)') }}
      />
    )
  }
  return (
    <iframe
      ref={ref}
      className="html-body"
      title="Message"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc.html}
      style={{ height }}
    />
  )
}