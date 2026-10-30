// Leopard: sign in to the team's takeoff software (leopard.5310s.com) with the same email as a mail account,
// or a separate Leopard email. Each person signs in with their own Leopard account on their own computer.
import { useEffect, useState } from 'react'
import type { LeopardStatus } from '../../../shared/ipc'
import { leopardApi } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Spinner } from '../components/ui'

const LEOPARD_URL = 'https://leopard.5310s.com'

export const fmtBytes = (n: number | null) => {
  if (n == null) return ''
  if (n < 1024 ** 2) return `${Math.max(0, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function LeopardTab() {
  const { accounts, toast } = useApp()
  const [status, setStatus] = useState<LeopardStatus | null>(null)
  const [mode, setMode] = useState<string>('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [url, setUrl] = useState(LEOPARD_URL)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const addresses = [...new Set(accounts.map((a) => a.email).filter(Boolean))]
  useEffect(() => {
    leopardApi.status().then((s) => {
      setStatus(s)
      setUrl(s.url || LEOPARD_URL)
      const known = s.email && addresses.includes(s.email)
      setMode(known ? s.email : addresses.length && !s.email ? addresses[0] : 'other')
      if (!known) setEmail(s.email)
    }).catch((e) => setError(e.message))
  }, [])

  const loginEmail = mode === 'other' ? email : mode
  const signIn = async () => {
    setBusy(true)
    setError('')
    try {
      const s = await leopardApi.login(url, loginEmail, password)
      setStatus(s)
      setPassword('')
      toast('Signed in to Leopard', 'success')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  const signOut = async () => {
    setBusy(true)
    try {
      setStatus(await leopardApi.logout())
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <div className="card"><Spinner label="Checking Leopard..." /></div>
  const pct = status.usedBytes != null && status.quotaBytes ? Math.min(100, (status.usedBytes / status.quotaBytes) * 100) : null

  return (
    <div className="settings-stack">
      <div className="card form-card leopard-card">
        <h3><Icon name="grid" /> Leopard takeoff</h3>
        <p className="muted">
          Connect BidMail to Leopard to link each job to its Leopard project, save the takeoff with the job, and turn its quantities
          into trades and request-for-bid emails. BidMail uses your Leopard account's storage (10 GB).
        </p>
        {status.signedIn ? (
          <>
            <div className="ok-box"><Icon name="check" /> Signed in to Leopard as <b>{status.email}</b></div>
            {pct != null && (
              <div className="storage-meter" title={`${fmtBytes(status.usedBytes)} of ${fmtBytes(status.quotaBytes)}`}>
                <div className="storage-bar"><span style={{ width: `${pct}%` }} className={pct > 90 ? 'full' : ''} /></div>
                <span className="small muted">Storage: {fmtBytes(status.usedBytes)} of {fmtBytes(status.quotaBytes)} used</span>
              </div>
            )}
            {status.error && <div className="warn-box small">{status.error}</div>}
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <Button icon="external" onClick={() => leopardApi.open()}>Open Leopard</Button>
              <Button icon="refresh" onClick={() => leopardApi.status().then(setStatus)}>Refresh</Button>
              <Button kind="danger" disabled={busy} onClick={signOut}>Sign out</Button>
            </div>
          </>
        ) : (
          <>
            {status.error && <div className="warn-box small">{status.error}</div>}
            <div className="form-grid">
              <Field label="Sign in with">
                <div className="radio-stack">
                  {addresses.map((a) => (
                    <label key={a} className="check">
                      <input type="radio" name="leopard-email" checked={mode === a} onChange={() => setMode(a)} /> The same email: <b>{a}</b>
                    </label>
                  ))}
                  <label className="check">
                    <input type="radio" name="leopard-email" checked={mode === 'other'} onChange={() => setMode('other')} /> {addresses.length ? 'A different Leopard email' : 'My Leopard email'}
                  </label>
                </div>
              </Field>
              {mode === 'other' && (
                <Field label="Leopard email">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
                </Field>
              )}
              <Field label="Leopard password" hint="Your Leopard password (not your email password). BidMail keeps only Leopard's sign-in, encrypted on this computer.">
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loginEmail && password && signIn()} />
              </Field>
              {advanced ? (
                <Field label="Leopard address">
                  <input value={url} onChange={(e) => setUrl(e.target.value)} />
                </Field>
              ) : (
                <button className="link-btn small" onClick={() => setAdvanced(true)}>Leopard address: {url}</button>
              )}
            </div>
            {error && <div className="error-box">{error}</div>}
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <Button kind="primary" disabled={busy || !loginEmail.trim() || !password} onClick={signIn}>{busy ? 'Signing in...' : 'Sign in to Leopard'}</Button>
              <Button icon="external" onClick={() => leopardApi.open()}>No account? Sign up in Leopard</Button>
            </div>
          </>
        )}
      </div>
      <div className="card form-card">
        <h3>How BidMail uses Leopard</h3>
        <ul className="plain-list">
          <li>On a job, <b>Link Leopard project</b> picks the project the takeoff is done in (or creates one from the job's details).</li>
          <li><b>Import takeoff</b> saves a copy of the takeoff with the job (shared with your team) and in the Leopard project's storage.</li>
          <li>BidMail groups the takeoff by trade (trade tag or CSI code) and can create the job's trades with their quantities.</li>
          <li>Request-for-bid emails can include each trade's quantities with <span className="mono">{'{{takeoff_quantities}}'}</span>.</li>
        </ul>
      </div>
    </div>
  )
}