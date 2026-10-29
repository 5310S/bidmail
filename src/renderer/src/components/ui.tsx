import { ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { cx } from '../util'

export function Button({
  children, onClick, kind = 'default', icon, disabled, title, small, type = 'button', className
}: {
  children?: ReactNode
  onClick?: (e: React.MouseEvent) => void
  kind?: 'default' | 'primary' | 'danger' | 'ghost' | 'success'
  icon?: string
  disabled?: boolean
  title?: string
  small?: boolean
  type?: 'button' | 'submit'
  className?: string
}) {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${kind}`, small && 'btn-sm', !children && 'btn-icon', className)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon name={icon} size={small ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  )
}

export function Modal({
  title, onClose, children, footer, width = 560, className
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number | string
  className?: string
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // Attach on the next tick: a dialog opened by a keypress must not receive that same keypress.
    const t = setTimeout(() => window.addEventListener('keydown', k), 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', k)
    }
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', className)} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close (Esc)">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export function Field({ label, children, hint, wide }: { label: string; children: ReactNode; hint?: ReactNode; wide?: boolean }) {
  return (
    <label className={cx('field', wide && 'field-wide')}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Empty({ icon = 'inbox', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={40} />
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  )
}

/** Dropdown menu anchored to its trigger button. */
export function Menu({
  trigger, items, align = 'left'
}: {
  trigger: (open: () => void) => ReactNode
  items: ({ label: ReactNode; icon?: string; onClick: () => void; danger?: boolean; disabled?: boolean } | 'sep')[]
  align?: 'left' | 'right'
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [pos])
  const open = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: align === 'right' ? r.right : r.left, y: r.bottom + 4 })
  }
  return (
    <span ref={ref} className="menu-anchor">
      {trigger(open)}
      {pos &&
        createPortal(
          <div
            className="menu"
            style={{
              top: Math.min(pos.y, window.innerHeight - 40 * items.length - 20),
              ...(align === 'right' ? { right: window.innerWidth - pos.x } : { left: pos.x })
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {items.map((it, i) =>
              it === 'sep' ? (
                <div key={i} className="menu-sep" />
              ) : (
                <button
                  key={i}
                  className={cx('menu-item', it.danger && 'danger')}
                  disabled={it.disabled}
                  onClick={() => {
                    setPos(null)
                    it.onClick()
                  }}
                >
                  {it.icon ? <Icon name={it.icon} size={16} /> : <span style={{ width: 16 }} />}
                  <span>{it.label}</span>
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </span>
  )
}

export interface ToastItem {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

export function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.kind}`)} onClick={() => dismiss(t.id)}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'mail'} size={18} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export function ConfirmDialog({
  title, message, confirmLabel = 'Delete', danger = true, onConfirm, onCancel
}: {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button kind={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-msg">{message}</div>
    </Modal>
  )
}

/** Small inline popover anchored below an element; closes on outside click. */
export function Popover({ anchor, onClose, children, width = 300 }: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const t = setTimeout(() => {
      window.addEventListener('mousedown', down)
      window.addEventListener('keydown', key)
    }, 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 16))
  const below = anchor.bottom + 320 < window.innerHeight
  return createPortal(
    <div
      ref={ref}
      className="popover"
      style={{ left, width, ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }) }}
    >
      {children}
    </div>,
    document.body
  )
}