import { useEffect, useRef, useState } from 'react'
import type { MailAccount, OAuthSettings } from '../../../shared/ipc'
import { accounts as accountsApi } from '../api'
import { TeamTab } from './TeamTab'
import { AboutTab } from './AboutTab'
import { RulesTab } from './RulesTab'
import { WorkflowTab } from './WorkflowTab'
import { LeopardTab } from './LeopardTab'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field, Modal } from '../components/ui'
import { cx, isMac } from '../util'
import { RichEditor, RichEditorHandle } from '../mail/RichEditor'

interface Preset {
  id: string
  label: string
  domains: RegExp
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
  saveSentCopy: boolean
  help: string
}

const PRESETS: Preset[] = [
  {
    id: 'gmail', label: 'Gmail / Google Workspace', domains: /gmail\.com|googlemail\.com/i,
    imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, saveSentCopy: false,
    help: 'Use a Google "App password": Google Account > Security > 2-Step Verification > App passwords. Your normal Gmail password will not work.'
  },
  {
    id: 'm365', label: 'Microsoft 365 (work Outlook)', domains: /$^/,
    imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false }, saveSentCopy: false,
    help: 'Your IT admin must allow IMAP and "Authenticated SMTP" for your mailbox. If sign-in is rejected, ask them to enable it or create an app password.'
  },
  {
    id: 'outlook', label: 'Outlook.com / Hotmail', domains: /outlook\.com|hotmail\.com|live\.com|msn\.com/i,
    imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false }, saveSentCopy: false,
    help: 'Turn on two-step verification and create an app password at account.microsoft.com > Security.'
  },
  {
    id: 'yahoo', label: 'Yahoo Mail', domains: /yahoo\.|ymail\.com/i,
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true }, saveSentCopy: true,
    help: 'Create an app password: Yahoo Account Security > Generate app password.'
  },
  {
    id: 'icloud', label: 'iCloud Mail', domains: /icloud\.com|me\.com|mac\.com/i,
    imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false }, saveSentCopy: true,
    help: 'Create an app-specific password at appleid.apple.com > Sign-In and Security.'
  },
  {
    id: 'other', label: 'Other (company email / IMAP)', domains: /$^/,
    imap: { host: '', port: 993, secure: true }, smtp: { host: '', port: 465, secure: true }, saveSentCopy: true,
    help: 'Get the incoming (IMAP) and outgoing (SMTP) server settings from your email provider or IT. Port 993 + SSL for IMAP and 465 SSL or 587 STARTTLS for SMTP are typical.'
  }
]

const COLORS = ['#2f6fdb', '#d9622b', '#2e9d6a', '#8a4fd1', '#c23d5f', '#1f8ea3']

export function SettingsView({ tab: initialTab }: { tab?: string }) {
  const [tab, setTab] = useState(initialTab ?? 'profile')
  useEffect(() => {
    if (initialTab) setTab(initialTab)
  }, [initialTab])
  return (
    <div className="page">
      <div className="page-head"><h1>Settings</h1></div>
      <div className="tabs">
        {[['profile', 'Profile'], ['accounts', 'Email Accounts'], ['team', 'Team Sharing'], ['workflow', 'Bid Workflow'], ['leopard', 'Leopard'], ['rules', 'Mail Rules'], ['reading', 'Reading'], ['about', 'About & Updates']].map(([k, v]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{v}</button>
        ))}
      </div>
      <div className="settings-body">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'team' && <TeamTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'workflow' && <WorkflowTab />}
        {tab === 'leopard' && <LeopardTab />}
        {tab === 'reading' && <ReadingTab />}
        {tab === 'about' && <AboutTab />}
      </div>
    </div>
  )
}

function ProfileTab() {
  const { settings, updateSettings, toast } = useApp()
  const [f, setF] = useState({ userName: settings.userName, companyName: settings.companyName, sendDelayMs: settings.sendDelayMs, notifications: settings.notifications })
  return (
    <div className="card form-card">
      <div className="form-grid">
        <Field label="Your name" hint="Used in templates ({{my_name}}) and shown to teammates in the activity history.">
          <input value={f.userName} onChange={(e) => setF({ ...f, userName: e.target.value })} />
        </Field>
        <Field label="Your company" hint="Used in templates as {{my_company}}.">
          <input value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} />
        </Field>
        <Field label="Pause between bulk emails (seconds)" hint="A short pause keeps mail servers from flagging bulk invitations as spam.">
          <input type="number" min={0.25} step={0.25} value={f.sendDelayMs / 1000} onChange={(e) => setF({ ...f, sendDelayMs: Math.round(Number(e.target.value) * 1000) })} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.notifications} onChange={(e) => setF({ ...f, notifications: e.target.checked })} /> Show a desktop notification when new mail arrives
        </label>
      </div>
      <div className="form-actions">
        <Button kind="primary" onClick={async () => { await updateSettings(f); toast('Saved', 'success') }}>Save</Button>
      </div>
    </div>
  )
}

function AccountsTab() {
  const { accounts, reloadAccounts, confirm, toast } = useApp()
  const [editing, setEditing] = useState<MailAccount | null | 'new'>(null)
  return (
    <div>
      <div className="card">
        {accounts.length === 0 && <p className="muted">No email accounts yet. Add your work email to start sending and receiving.</p>}
        {accounts.map((a) => (
          <div key={a.id} className="acct-row">
            <span className="acct-dot big" style={{ background: a.color }} />
            <div className="grow">
              <b>{a.displayName || a.email}</b>
              <div className="muted small">{a.email} · {a.authType === 'oauth' ? `Signed in with ${a.oauthProvider === 'google' ? 'Google' : 'Microsoft'}` : a.imap.host}</div>
            </div>
            <Button icon="edit" onClick={() => setEditing(a)}>Edit</Button>
            <Button
              kind="ghost"
              icon="trash"
              onClick={async () => {
                if (await confirm({ title: 'Remove account?', message: `Remove ${a.email} from BidMail? Mail on the server is not affected.`, confirmLabel: 'Remove' })) {
                  await accountsApi.remove(a.id)
                  await reloadAccounts()
                  toast('Account removed', 'success')
                }
              }}
            />
          </div>
        ))}
        <div className="form-actions"><Button kind="primary" icon="plus" onClick={() => setEditing('new')}>Add Account</Button></div>
      </div>
      <SignInSetup />
      {editing && <AccountEditor account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

/** New account: choose Microsoft / Google sign-in or a password (IMAP). Signed-in accounts get their own editor. */
function AccountEditor({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const [method, setMethod] = useState<'choose' | 'password'>(account ? 'password' : 'choose')
  if (account?.authType === 'oauth') return <OAuthAccountEditor account={account} onClose={onClose} />
  if (method === 'choose') return <ChooseMethod onPassword={() => setMethod('password')} onClose={onClose} />
  return <PasswordAccountEditor account={account} onClose={onClose} />
}

function useOAuthSignIn(onDone: () => void) {
  const { reloadAccounts, toast, settings } = useApp()
  const [busy, setBusy] = useState<'microsoft' | 'google' | null>(null)
  const configured = (p: 'microsoft' | 'google') => (p === 'microsoft' ? !!settings.oauth.microsoftClientId : !!settings.oauth.googleClientId)
  const signIn = async (p: 'microsoft' | 'google', existingId?: string) => {
    setBusy(p)
    try {
      const a = await accountsApi.oauth(p, existingId)
      await reloadAccounts()
      toast(`Signed in as ${a.email}`, 'success')
      onDone()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(null)
    }
  }
  return { busy, signIn, configured }
}

function ChooseMethod({ onPassword, onClose }: { onPassword: () => void; onClose: () => void }) {
  const { busy, signIn, configured } = useOAuthSignIn(onClose)
  const [setup, setSetup] = useState(false)
  return (
    <Modal title="Add email account" onClose={onClose} width={620}>
      <div className="method-list">
        {(['microsoft', 'google'] as const).map((p) => (
          <button key={p} className="method" disabled={!!busy} onClick={() => (configured(p) ? signIn(p) : setSetup(true))}>
            <span className={`method-logo ${p}`}>{p === 'microsoft' ? 'M' : 'G'}</span>
            <span className="grow">
              <b>Sign in with {p === 'microsoft' ? 'Microsoft' : 'Google'}</b>
              <span className="muted small">{p === 'microsoft' ? 'Microsoft 365 / work Outlook, Outlook.com, Hotmail' : 'Gmail and Google Workspace'}. No app password needed.</span>
              {!configured(p) && <span className="warn-text small">Needs a one-time setup by whoever manages your company's {p === 'microsoft' ? 'Microsoft 365' : 'Google Workspace'}.</span>}
            </span>
            {busy === p ? <span className="spinner sm" /> : <Icon name="chevronRight" />}
          </button>
        ))}
        <button className="method" onClick={onPassword}>
          <span className="method-logo other"><Icon name="mail" size={18} /></span>
          <span className="grow">
            <b>Other email (password)</b>
            <span className="muted small">Company mail server, Yahoo, iCloud, or Gmail/Outlook with an app password.</span>
          </span>
          <Icon name="chevronRight" />
        </button>
      </div>
      {busy && <p className="muted">Finish signing in in your web browser, then come back here.</p>}
      {setup && <div style={{ marginTop: 14 }}><SignInSetup open /></div>}
    </Modal>
  )
}

function OAuthAccountEditor({ account, onClose }: { account: MailAccount; onClose: () => void }) {
  const { reloadAccounts, toast } = useApp()
  const { busy, signIn } = useOAuthSignIn(onClose)
  const [a, setA] = useState(account)
  const sig = useRef<RichEditorHandle>(null)
  const provider = account.oauthProvider ?? 'microsoft'
  const save = async () => {
    try {
      await accountsApi.save({ account: { ...a, signature: sig.current?.getHtml() ?? a.signature } })
      await reloadAccounts()
      toast('Account saved', 'success')
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <Modal title={`Edit ${account.email}`} onClose={onClose} width={680}
      footer={<><Button onClick={() => signIn(provider, account.id)} disabled={!!busy}>{busy ? 'Waiting for browser...' : 'Sign in again'}</Button><span className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
      <div className="ok-box"><Icon name="check" /> Signed in with {provider === 'google' ? 'Google' : 'Microsoft'} as {account.email}. If mail stops working (for example after a password change), click "Sign in again".</div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <Field label="Your name (as recipients see it)" wide><input value={a.displayName} onChange={(e) => setA({ ...a, displayName: e.target.value })} /></Field>
      </div>
      <div className="field-label" style={{ marginTop: 14 }}>Signature</div>
      <RichEditor ref={sig} initialHtml={a.signature} minHeight={90} />
      <div className="field-label" style={{ marginTop: 14 }}>Color</div>
      <div className="color-pick">
        {COLORS.map((c) => <button key={c} className={cx(a.color === c && 'on')} style={{ background: c }} onClick={() => setA({ ...a, color: c })} />)}
      </div>
    </Modal>
  )
}

/** One-time company setup for Sign in with Microsoft / Google (app registration client IDs). */
function SignInSetup({ open: startOpen }: { open?: boolean }) {
  const { settings, updateSettings, toast } = useApp()
  const [open, setOpen] = useState(!!startOpen)
  const [o, setO] = useState<OAuthSettings>(settings.oauth)
  return (
    <div className="card form-card" style={{ marginTop: 14 }}>
      <button className="link-btn" style={{ fontWeight: 600 }} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} /> Sign-in setup for Microsoft & Google (one time, per company)
      </button>
      {open && (
        <>
          <p className="muted small">
            Microsoft and Google only allow mail sign-in from apps registered by your organization. Whoever manages your Microsoft 365 or
            Google Workspace registers BidMail once (free, about 10 minutes; step-by-step instructions are in README.md under
            "Sign in with Microsoft / Google") and pastes the IDs here. Then everyone signs in with their normal work login.
          </p>
          <div className="form-grid">
            <Field label="Microsoft application (client) ID"><input value={o.microsoftClientId} onChange={(e) => setO({ ...o, microsoftClientId: e.target.value.trim() })} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
            <Field label="Microsoft tenant" hint="'common' works for most; or your tenant ID / domain."><input value={o.microsoftTenant} onChange={(e) => setO({ ...o, microsoftTenant: e.target.value.trim() })} /></Field>
            <Field label="Google client ID"><input value={o.googleClientId} onChange={(e) => setO({ ...o, googleClientId: e.target.value.trim() })} placeholder="...apps.googleusercontent.com" /></Field>
            <Field label="Google client secret" hint="Google issues one for desktop apps; it is stored encrypted."><input type="password" value={o.googleClientSecret} onChange={(e) => setO({ ...o, googleClientSecret: e.target.value.trim() })} /></Field>
          </div>
          <div className="form-actions"><Button kind="primary" onClick={() => updateSettings({ oauth: o }).then(() => toast('Sign-in setup saved', 'success'))}>Save</Button></div>
        </>
      )}
    </div>
  )
}

function PasswordAccountEditor({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const { reloadAccounts, toast, settings } = useApp()
  const [a, setA] = useState<MailAccount>(
    account ?? {
      id: '', displayName: settings.userName, email: '', signature: '',
      imap: { host: '', port: 993, secure: true, user: '' },
      smtp: { host: '', port: 465, secure: true, user: '' },
      color: COLORS[Math.floor(Math.random() * COLORS.length)], saveSentCopy: true, allowInvalidCerts: false
    }
  )
  const [password, setPassword] = useState('')
  const [preset, setPreset] = useState<string>(account ? 'other' : '')
  const [advanced, setAdvanced] = useState(!!account)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const sig = useRef<RichEditorHandle>(null)
  const p = PRESETS.find((x) => x.id === preset)

  const applyPreset = (id: string, email = a.email) => {
    const pr = PRESETS.find((x) => x.id === id)
    setPreset(id)
    if (!pr) return
    const domain = email.split('@')[1] ?? ''
    setA((x) => ({
      ...x,
      imap: { ...pr.imap, host: pr.imap.host || (domain ? `mail.${domain}` : ''), user: x.imap.user },
      smtp: { ...pr.smtp, host: pr.smtp.host || (domain ? `mail.${domain}` : ''), user: x.smtp.user },
      saveSentCopy: pr.saveSentCopy
    }))
    if (id === 'other') setAdvanced(true)
  }

  const onEmail = (email: string) => {
    setA((x) => ({ ...x, email }))
    if (!account) {
      const match = PRESETS.find((x) => x.domains.test(email.split('@')[1] ?? ''))
      if (match && match.id !== preset) applyPreset(match.id, email)
      else if (!preset && email.includes('@') && email.split('@')[1]?.includes('.')) applyPreset('other', email)
    }
  }

  const current = (): MailAccount => ({ ...a, signature: sig.current?.getHtml() ?? a.signature })

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const msg = await accountsApi.test(current(), password || undefined)
      setResult({ ok: true, text: msg })
    } catch (e: any) {
      setResult({ ok: false, text: e.message })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!a.email.includes('@')) return toast('Enter your email address.', 'error')
    if (!a.imap.host || !a.smtp.host) return toast('Enter the incoming and outgoing server names.', 'error')
    if (!account && !password) return toast('Enter the password (or app password).', 'error')
    try {
      await accountsApi.save({ account: current(), password: password || undefined })
      await reloadAccounts()
      toast('Account saved', 'success')
      onClose()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const srv = (k: 'imap' | 'smtp', field: string, value: any) => setA((x) => ({ ...x, [k]: { ...x[k], [field]: value } }))

  return (
    <Modal
      title={account ? `Edit ${account.email}` : 'Add email account'}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={test} disabled={testing || !a.imap.host}>{testing ? 'Testing...' : 'Test connection'}</Button>
          <span className="grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={save}>Save</Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Email address"><input autoFocus={!account} value={a.email} onChange={(e) => onEmail(e.target.value.trim())} placeholder="you@company.com" /></Field>
        <Field label="Your name (as recipients see it)"><input value={a.displayName} onChange={(e) => setA({ ...a, displayName: e.target.value })} /></Field>
        <Field label="Email provider" wide>
          <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
            <option value="" disabled>Choose...</option>
            {PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </Field>
        <Field label={account ? 'Password (leave blank to keep the saved one)' : 'Password / app password'} wide hint={p?.help}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>

      <button className="link-btn" onClick={() => setAdvanced(!advanced)}>
        <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} /> Server settings
      </button>
      {advanced && (
        <div className="server-grid">
          {(['imap', 'smtp'] as const).map((k) => (
            <div key={k} className="server-box">
              <div className="field-label">{k === 'imap' ? 'Incoming mail (IMAP)' : 'Outgoing mail (SMTP)'}</div>
              <Field label="Server"><input value={a[k].host} onChange={(e) => srv(k, 'host', e.target.value.trim())} /></Field>
              <div className="form-grid">
                <Field label="Port"><input type="number" value={a[k].port} onChange={(e) => srv(k, 'port', Number(e.target.value))} /></Field>
                <Field label="Security">
                  <select value={a[k].secure ? 'ssl' : 'starttls'} onChange={(e) => srv(k, 'secure', e.target.value === 'ssl')}>
                    <option value="ssl">SSL/TLS</option>
                    <option value="starttls">STARTTLS</option>
                  </select>
                </Field>
              </div>
              <Field label="Username (if different from email)"><input value={a[k].user} onChange={(e) => srv(k, 'user', e.target.value.trim())} placeholder={a.email} /></Field>
            </div>
          ))}
          <label className="check">
            <input type="checkbox" checked={a.saveSentCopy} onChange={(e) => setA({ ...a, saveSentCopy: e.target.checked })} />
            Save a copy of sent mail to the Sent folder (turn off for Gmail and Outlook, which do it automatically)
          </label>
          <label className="check">
            <input type="checkbox" checked={a.allowInvalidCerts} onChange={(e) => setA({ ...a, allowInvalidCerts: e.target.checked })} />
            Allow untrusted security certificates (only for company servers with self-signed certificates)
          </label>
        </div>
      )}

      <div className="field-label" style={{ marginTop: 14 }}>Signature</div>
      <RichEditor ref={sig} initialHtml={a.signature} minHeight={90} />

      <div className="field-label" style={{ marginTop: 14 }}>Color</div>
      <div className="color-pick">
        {COLORS.map((c) => (
          <button key={c} className={cx(a.color === c && 'on')} style={{ background: c }} onClick={() => setA({ ...a, color: c })} />
        ))}
      </div>

      {result && <div className={result.ok ? 'ok-box' : 'warn-box'}><Icon name={result.ok ? 'check' : 'alert'} /> {result.text}</div>}
    </Modal>
  )
}

function ReadingTab() {
  const { settings, updateSettings } = useApp()
  const r = settings.reading
  const set = (patch: Partial<typeof r>) => updateSettings({ reading: { ...r, ...patch } })
  return (
    <div className="card form-card">
      <div className="form-grid">
        <Field label={`Message text size: ${r.fontSize}px`} wide>
          <input type="range" min={12} max={28} value={r.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
        </Field>
        <Field label="Theme">
          <select value={r.theme} onChange={(e) => set({ theme: e.target.value as any })}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">{isMac ? 'Match macOS' : 'Match Windows'}</option>
          </select>
        </Field>
        <label className="check field-wide">
          <input type="checkbox" checked={r.simpleView} onChange={(e) => set({ simpleView: e.target.checked })} />
          Simple view: show every email as clean, large plain text (easiest to read)
        </label>
        <label className="check field-wide">
          <input type="checkbox" checked={r.loadRemoteImages} onChange={(e) => set({ loadRemoteImages: e.target.checked })} />
          Always load pictures from the internet (off blocks tracking pixels)
        </label>
        {settings.trustedImageSenders.length > 0 && (
          <div className="field-wide">
            <div className="field-label">Always show pictures from</div>
            {settings.trustedImageSenders.map((s) => (
              <span key={s} className="tag">
                {s}{' '}
                <button className="link-btn" onClick={() => updateSettings({ trustedImageSenders: settings.trustedImageSenders.filter((x) => x !== s) })}>remove</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

