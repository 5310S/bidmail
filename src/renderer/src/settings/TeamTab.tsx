// Team Sharing: work alone, host the team's data on this computer, or sign in to a team server.
// Each teammate has their own login; every change is recorded with their name.
import { useEffect, useState } from 'react'
import type { TeamMode } from '../../../shared/ipc'
import type { AuditEntry, TeamUser } from '../../../shared/types'
import { bid, ServerCert, team as teamApi } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Modal } from '../components/ui'
import { cx, fmtDateTime, isMac } from '../util'

export function TeamTab() {
  const { settings, team, setTeam, toast } = useApp()
  const t = settings.team
  const [mode, setMode] = useState<TeamMode>(team?.mode ?? t.mode)
  const [port, setPort] = useState(t.port || 4780)
  const [https, setHttps] = useState(t.https)
  const [key, setKey] = useState(t.key)
  const [busy, setBusy] = useState(false)

  const genKey = () => {
    const a = new Uint8Array(9)
    crypto.getRandomValues(a)
    return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, '').slice(0, 12)
  }
  const apply = async (patch: Parameters<typeof teamApi.apply>[0]) => {
    setBusy(true)
    try {
      const s = await teamApi.apply(patch)
      setTeam(s)
      toast(s.error ? s.error : 'Team settings applied', s.error ? 'error' : 'success')
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const signedIn = team?.mode === 'remote' && !!t.token && !team.needsLogin

  const card = (m: TeamMode, title: string, desc: string) => (
    <label className={cx('mode-card', mode === m && 'on')}>
      <input type="radio" checked={mode === m} onChange={() => { setMode(m); if (m === 'host' && !key) setKey(genKey()) }} />
      <div><b>{title}</b><div className="muted small">{desc}</div></div>
    </label>
  )

  return (
    <div className="settings-stack">
      <div className="card form-card">
        <p className="muted">Share jobs, trades, companies, statuses, quotes and templates with your team. Email accounts and messages stay private to each person.</p>
        <div className="mode-cards">
          {card('local', 'Just this computer', 'Your bid data is stored only on this computer.')}
          {card('host', 'Host team data here', 'Teammates connect to this computer over the office network. Keep it on with BidMail open.')}
          {card('remote', 'Connect to a team server', "Sign in to a teammate's computer or the always-on BidMail Team Server.")}
        </div>

        {mode === 'local' && team?.mode !== 'local' && (
          <div className="form-actions"><Button kind="primary" disabled={busy} onClick={() => apply({ mode: 'local' })}>Use only this computer</Button></div>
        )}

        {mode === 'host' && (
          <>
            <div className="form-grid">
              <Field label="Port"><input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} /></Field>
              <Field label="Setup key" hint="Lets older BidMail versions connect while no logins exist. Keep it private.">
                <div className="input-with-btn">
                  <input value={key} onChange={(e) => setKey(e.target.value.trim())} />
                  <Button onClick={() => setKey(genKey())}>New</Button>
                </div>
              </Field>
              <label className="check field-wide">
                <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} />
                Encrypt connections (HTTPS). Recommended: teammates confirm this computer's certificate the first time.
              </label>
            </div>
            <div className="form-actions">
              <Button kind="primary" disabled={busy || !key} onClick={() => apply({ mode: 'host', port, https, key })}>
                {team?.mode === 'host' ? 'Apply changes' : 'Start hosting'}
              </Button>
            </div>
            {team?.mode === 'host' && team.connected && (
              <div className="ok-box">
                <Icon name="wifi" />
                <div>
                  Hosting is on. Teammates choose <b>Connect to a team server</b> and enter one of these addresses:
                  <ul>{team.addresses.map((x) => <li key={x} className="mono">{x}</li>)}</ul>
                  {team.https && <div>Certificate fingerprint they should see: <span className="mono small">{team.fingerprint}</span></div>}
                  <div>{isMac ? 'If macOS asks whether BidMail may accept incoming connections, click Allow.' : 'If Windows Firewall asks, allow BidMail on private networks.'}</div>
                </div>
              </div>
            )}
          </>
        )}

        {mode === 'remote' && (signedIn ? (
          <SignedIn onSignOut={() => teamApi.logout().then(setTeam)} />
        ) : (
          <ConnectFlow initialUrl={t.url} initialCert={t.certPem} onDone={(s) => { setTeam(s); toast('Signed in to the team server', 'success') }} />
        ))}

        {team?.error && team.mode === mode && <div className="warn-box"><Icon name="alert" /> {team.error}</div>}
      </div>

      {(team?.mode === 'host' || (signedIn && team?.user?.role === 'admin')) && <UsersPanel host={team?.mode === 'host'} />}
      <ChangeHistory />
    </div>
  )
}

function SignedIn({ onSignOut }: { onSignOut: () => void }) {
  const { team, settings, toast, setTeam } = useApp()
  const [pw, setPw] = useState<{ current: string; next: string } | null>(null)
  return (
    <div className="signed-in">
      <Icon name={team?.connected ? 'wifi' : 'wifiOff'} />
      <div className="grow">
        Signed in as <b>{team?.user?.displayName ?? settings.team.username}</b> ({team?.user?.role === 'admin' ? 'admin' : 'member'})
        <div className="muted small mono">{settings.team.url}{team?.https ? ' · encrypted' : ''}</div>
      </div>
      <Button onClick={() => setPw({ current: '', next: '' })}>Change password</Button>
      <Button onClick={onSignOut}>Sign out</Button>
      {pw && (
        <Modal title="Change your team password" onClose={() => setPw(null)} width={420}
          footer={<><Button onClick={() => setPw(null)}>Cancel</Button><Button kind="primary" onClick={async () => {
            try {
              setTeam(await teamApi.changePassword(pw.current, pw.next))
              toast('Password changed', 'success')
              setPw(null)
            } catch (e: any) {
              toast(e.message, 'error')
            }
          }}>Change</Button></>}>
          <div className="form-grid">
            <Field label="Current password" wide><input type="password" autoFocus value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
            <Field label="New password (8+ characters)" wide><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** Server address -> (trust certificate) -> sign in, or create the first admin with the setup key. */
function ConnectFlow({ initialUrl, initialCert, onDone }: { initialUrl: string; initialCert: string; onDone: (s: any) => void }) {
  const { settings, toast } = useApp()
  const [url, setUrl] = useState(initialUrl)
  const [cert, setCert] = useState<ServerCert | null>(null)
  const [pinned, setPinned] = useState(initialCert)
  const [step, setStep] = useState<'url' | 'cert' | 'login' | 'setup'>('url')
  const [f, setF] = useState({ username: settings.team.username, password: '', setupKey: '', displayName: settings.userName })
  const [busy, setBusy] = useState(false)

  const next = async () => {
    setBusy(true)
    try {
      const full = /^https?:\/\//i.test(url.trim()) ? url.trim() : 'https://' + url.trim()
      setUrl(full)
      let pin = pinned
      if (full.startsWith('https:')) {
        const c = await teamApi.cert(full)
        if (c && !c.trusted && c.pem !== pinned) {
          setCert(c)
          setStep('cert')
          return
        }
        if (c?.trusted) pin = ''
      } else pin = ''
      setPinned(pin)
      const h = await teamApi.health(full, pin || undefined)
      setStep(h.needsSetup ? 'setup' : 'login')
    } catch (e: any) {
      // An address typed without http(s) may be a plain-HTTP server: try that before giving up.
      if (!/^https?:\/\//i.test(url.trim()) || /ECONNRESET|EPROTO|wrong version/i.test(e.message)) {
        try {
          const plain = 'http://' + url.trim().replace(/^https?:\/\//i, '')
          const h = await teamApi.health(plain)
          setUrl(plain)
          setPinned('')
          setStep(h.needsSetup ? 'setup' : 'login')
          return
        } catch {
          /* fall through */
        }
      }
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    setBusy(true)
    try {
      const s = step === 'setup'
        ? await teamApi.setup(url, f.setupKey, f.username, f.password, f.displayName, pinned || undefined)
        : await teamApi.login(url, f.username, f.password, pinned || undefined)
      onDone(s)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="connect-flow">
      <div className="form-grid">
        <Field label="Team server address" wide hint="e.g. 192.168.1.20:4780 or https://bids.yourcompany.com">
          <div className="input-with-btn">
            <input value={url} onChange={(e) => { setUrl(e.target.value); setStep('url') }} placeholder="192.168.1.20:4780" onKeyDown={(e) => e.key === 'Enter' && next()} />
            {step === 'url' && <Button kind="primary" disabled={busy || !url.trim()} onClick={next}>{busy ? 'Checking...' : 'Continue'}</Button>}
          </div>
        </Field>
      </div>
      {step === 'cert' && cert && (
        <div className="warn-box cert-box">
          <Icon name="alert" />
          <div className="grow">
            <b>First time connecting to this server.</b> Its security certificate is self-signed (normal for an office server).
            Make sure the fingerprint matches what the host computer shows in its Team Sharing settings:
            <div className="mono small cert-fp">{cert.fingerprint}</div>
            <div className="small">{cert.subject} · valid until {cert.validTo}</div>
            <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
              <Button kind="primary" onClick={async () => {
                setPinned(cert.pem)
                setCert(null)
                try {
                  const h = await teamApi.health(url, cert.pem)
                  setStep(h.needsSetup ? 'setup' : 'login')
                } catch (e: any) {
                  toast(e.message, 'error')
                  setStep('url')
                }
              }}>It matches: trust this server</Button>
              <Button onClick={() => setStep('url')}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
      {(step === 'login' || step === 'setup') && (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit() }}>
          {step === 'setup' && (
            <>
              <div className="ok-box field-wide"><Icon name="users" /> This server has no accounts yet. Create the first admin account using the setup key shown when the server started.</div>
              <Field label="Setup key"><input value={f.setupKey} onChange={(e) => setF({ ...f, setupKey: e.target.value.trim() })} /></Field>
              <Field label="Your name (shown to teammates)"><input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
            </>
          )}
          <Field label="Username"><input autoFocus value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.trim() })} /></Field>
          <Field label={step === 'setup' ? 'Choose a password (8+ characters)' : 'Password'}><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <div className="form-actions field-wide">
            <Button onClick={() => setStep('url')}>Back</Button>
            <Button kind="primary" type="submit" disabled={busy || !f.username || !f.password}>{step === 'setup' ? 'Create admin & sign in' : 'Sign in'}</Button>
          </div>
        </form>
      )}
    </div>
  )
}

function UsersPanel({ host }: { host: boolean }) {
  const { toast, confirm, team } = useApp()
  const [users, setUsers] = useState<TeamUser[]>([])
  const [adding, setAdding] = useState(false)
  const [reset, setReset] = useState<TeamUser | null>(null)
  const [nu, setNu] = useState({ username: '', displayName: '', password: '', role: 'member' as 'admin' | 'member' })
  const [newPw, setNewPw] = useState('')
  const load = () => teamApi.users().then(setUsers).catch((e) => toast(e.message, 'error'))
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const update = async (u: TeamUser, patch: Parameters<typeof teamApi.updateUser>[1]) => {
    try {
      await teamApi.updateUser(u.id, patch)
      load()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <div className="card form-card">
      <h3>Team logins</h3>
      {host && users.length === 0 && (
        <div className="warn-box"><Icon name="alert" /> No logins yet: anyone with the setup key can connect. Add a login for each teammate (and yourself, to manage users from another computer).</div>
      )}
      <table className="data-table compact">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={cx(!u.active && 'lv-dim')}>
              <td><b>{u.displayName}</b>{!u.active && <span className="tag">deactivated</span>}{u.id === team?.user?.id && <span className="tag">you</span>}</td>
              <td className="mono">{u.username}</td>
              <td>
                <select value={u.role} onChange={(e) => update(u, { role: e.target.value as 'admin' | 'member' })}>
                  <option value="member">Member</option>
                  <option value="admin">Admin (manages logins)</option>
                </select>
              </td>
              <td className="muted small">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'never'}</td>
              <td className="row-actions">
                <Button small onClick={() => { setReset(u); setNewPw('') }}>Reset password</Button>
                {u.active ? (
                  <Button small kind="danger" onClick={async () => { if (await confirm({ title: 'Deactivate login?', message: `${u.displayName} will be signed out and can no longer connect.`, confirmLabel: 'Deactivate' })) update(u, { active: false }) }}>Deactivate</Button>
                ) : (
                  <Button small onClick={() => update(u, { active: true })}>Reactivate</Button>
                )}
              </td>
            </tr>
          ))}
          {users.length === 0 && <tr><td colSpan={5} className="muted">No logins.</td></tr>}
        </tbody>
      </table>
      <div className="form-actions"><Button kind="primary" icon="plus" onClick={() => { setNu({ username: '', displayName: '', password: '', role: users.length ? 'member' : 'admin' }); setAdding(true) }}>Add teammate</Button></div>
      {adding && (
        <Modal title="Add a teammate login" onClose={() => setAdding(false)} width={480}
          footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button kind="primary" onClick={async () => {
            try {
              await teamApi.createUser(nu)
              toast(`Login created for ${nu.displayName || nu.username}. Give them the username and password.`, 'success')
              setAdding(false)
              load()
            } catch (e: any) {
              toast(e.message, 'error')
            }
          }}>Create login</Button></>}>
          <div className="form-grid">
            <Field label="Name (shown in history)"><input autoFocus value={nu.displayName} onChange={(e) => setNu({ ...nu, displayName: e.target.value })} /></Field>
            <Field label="Username"><input value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value.trim() })} placeholder="e.g. pat" /></Field>
            <Field label="Temporary password (8+ characters)"><input value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></Field>
            <Field label="Role">
              <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as 'admin' | 'member' })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}
      {reset && (
        <Modal title={`Reset password for ${reset.displayName}`} onClose={() => setReset(null)} width={420}
          footer={<><Button onClick={() => setReset(null)}>Cancel</Button><Button kind="primary" onClick={() => { update(reset, { password: newPw }).then(() => toast('Password reset. They are signed out until they use the new one.', 'success')); setReset(null) }}>Reset</Button></>}>
          <Field label="New password (8+ characters)"><input autoFocus value={newPw} onChange={(e) => setNewPw(e.target.value)} /></Field>
        </Modal>
      )}
    </div>
  )
}

function ChangeHistory() {
  const { rev } = useApp()
  const [list, setList] = useState<AuditEntry[]>([])
  const [q, setQ] = useState('')
  useEffect(() => {
    bid.listAudit(null, 300).then(setList).catch(() => {})
  }, [rev])
  const shown = list.filter((x) => !q || (x.userName + ' ' + x.summary).toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="card form-card">
      <div className="toolbar" style={{ margin: 0 }}>
        <h3 className="grow">Change history</h3>
        <div className="search-box"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by person or change" /></div>
      </div>
      <ul className="history big audit">
        {shown.map((c) => (
          <li key={c.id}>
            <span className="h-when">{fmtDateTime(c.at)}</span>
            <b>{c.userName || 'Someone'}</b>
            <span className="h-note">{c.summary}</span>
          </li>
        ))}
        {shown.length === 0 && <li className="muted">No changes recorded yet.</li>}
      </ul>
    </div>
  )
}