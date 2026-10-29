import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { modKey } from '../util'

export interface RichEditorHandle {
  getHtml: () => string
  setHtml: (html: string) => void
  insertHtml: (html: string) => void
  focus: () => void
  element: () => HTMLDivElement | null
}

const exec = (cmd: string, value?: string) => document.execCommand(cmd, false, value)

/** Lightweight rich-text editor (contenteditable) with the formatting estimators actually use. */
export const RichEditor = forwardRef<RichEditorHandle, { initialHtml: string; onChange?: () => void; minHeight?: number; placeholder?: string }>(
  function RichEditor({ initialHtml, onChange, minHeight = 260, placeholder }, ref) {
    const el = useRef<HTMLDivElement>(null)
    const savedRange = useRef<Range | null>(null)
    const [linkOpen, setLinkOpen] = useState(false)
    const [linkUrl, setLinkUrl] = useState('')

    useEffect(() => {
      if (el.current) el.current.innerHTML = initialHtml
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const saveSelection = () => {
      const sel = window.getSelection()
      if (sel && sel.rangeCount && el.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange()
    }
    const restoreSelection = () => {
      el.current?.focus()
      const sel = window.getSelection()
      if (savedRange.current && sel) {
        sel.removeAllRanges()
        sel.addRange(savedRange.current)
      }
    }

    useImperativeHandle(ref, () => ({
      getHtml: () => el.current?.innerHTML ?? '',
      setHtml: (h) => {
        if (el.current) el.current.innerHTML = h
      },
      insertHtml: (h) => {
        restoreSelection()
        exec('insertHTML', h)
        onChange?.()
      },
      focus: () => el.current?.focus(),
      element: () => el.current
    }))

    const btn = (icon: string, title: string, fn: () => void) => (
      <button
        type="button"
        className="rte-btn"
        title={title}
        onMouseDown={(e) => {
          e.preventDefault()
          fn()
          onChange?.()
        }}
      >
        <Icon name={icon} size={16} />
      </button>
    )

    return (
      <div className="rte">
        <div className="rte-toolbar">
          {btn('bold', `Bold (${modKey}+B)`, () => exec('bold'))}
          {btn('italic', `Italic (${modKey}+I)`, () => exec('italic'))}
          {btn('underline', `Underline (${modKey}+U)`, () => exec('underline'))}
          <select
            className="rte-select"
            title="Text size"
            defaultValue=""
            onMouseDown={saveSelection}
            onChange={(e) => {
              restoreSelection()
              exec('fontSize', e.target.value)
              e.target.value = ''
              onChange?.()
            }}
          >
            <option value="" disabled>Size</option>
            <option value="2">Small</option>
            <option value="3">Normal</option>
            <option value="4">Large</option>
            <option value="5">Larger</option>
          </select>
          <label className="rte-color" title="Text color" onMouseDown={saveSelection}>
            <span>A</span>
            <input
              type="color"
              onChange={(e) => {
                restoreSelection()
                exec('foreColor', e.target.value)
                onChange?.()
              }}
            />
          </label>
          <label className="rte-color hl" title="Highlight" onMouseDown={saveSelection}>
            <span>H</span>
            <input
              type="color"
              defaultValue="#fff59d"
              onChange={(e) => {
                restoreSelection()
                exec('hiliteColor', e.target.value)
                onChange?.()
              }}
            />
          </label>
          <span className="rte-sep" />
          {btn('list', 'Bulleted list', () => exec('insertUnorderedList'))}
          {btn('listOrdered', 'Numbered list', () => exec('insertOrderedList'))}
          {btn('link', 'Insert link', () => {
            saveSelection()
            setLinkUrl('https://')
            setLinkOpen(true)
          })}
          {btn('eraser', 'Clear formatting', () => exec('removeFormat'))}
          {linkOpen && (
            <form
              className="rte-link"
              onSubmit={(e) => {
                e.preventDefault()
                const url = linkUrl.trim()
                setLinkOpen(false)
                if (!url || url === 'https://') return
                restoreSelection()
                const sel = window.getSelection()
                if (!sel || sel.isCollapsed) exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>&nbsp;`)
                else exec('createLink', url)
                onChange?.()
              }}
            >
              <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setLinkOpen(false)} />
              <button type="submit" className="btn btn-sm btn-primary">Add link</button>
              <button type="button" className="btn btn-sm" onClick={() => setLinkOpen(false)}>Cancel</button>
            </form>
          )}
        </div>
        <div
          ref={el}
          className="rte-body"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          data-placeholder={placeholder}
          style={{ minHeight }}
          onInput={() => onChange?.()}
          onBlur={saveSelection}
          onKeyUp={saveSelection}
          onMouseUp={saveSelection}
        />
      </div>
    )
  }
)