import { useEffect, useMemo, useRef, useState } from 'react'

export interface Contact {
  name: string
  email: string
  detail?: string
}

/** Comma-separated address field with suggestions from the company directory and job bidders. */
export function AddressInput({
  value, onChange, contacts, placeholder, autoFocus
}: {
  value: string
  onChange: (v: string) => void
  contacts: Contact[]
  placeholder?: string
  autoFocus?: boolean
}) {
  const [focus, setFocus] = useState(false)
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLInputElement>(null)
  const token = value.split(/[,;]/).pop()?.trim().toLowerCase() ?? ''

  const suggestions = useMemo(() => {
    if (token.length < 1) return []
    const out: Contact[] = []
    const seen = new Set<string>()
    for (const c of contacts) {
      if (seen.has(c.email)) continue
      if (c.email.toLowerCase().includes(token) || c.name.toLowerCase().includes(token) || c.detail?.toLowerCase().includes(token)) {
        out.push(c)
        seen.add(c.email)
        if (out.length >= 8) break
      }
    }
    return out
  }, [token, contacts])

  useEffect(() => setHi(0), [token])

  const pick = (c: Contact) => {
    const parts = value.split(/[,;]/)
    parts.pop()
    const entry = c.name ? `${c.name.replace(/[,;"<>]/g, '')} <${c.email}>` : c.email
    const next = [...parts.map((p) => p.trim()).filter(Boolean), entry].join(', ') + ', '
    onChange(next)
    ref.current?.focus()
  }

  return (
    <div className="addr-input">
      <input
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (!suggestions.length || !focus) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => Math.min(suggestions.length - 1, h + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => Math.max(0, h - 1))
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            pick(suggestions[hi])
          }
        }}
      />
      {focus && suggestions.length > 0 && (
        <div className="addr-suggest">
          {suggestions.map((c, i) => (
            <button
              key={c.email}
              type="button"
              className={i === hi ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
            >
              <b>{c.name || c.email}</b> <span className="muted">{c.email}</span>
              {c.detail && <span className="addr-detail">{c.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}