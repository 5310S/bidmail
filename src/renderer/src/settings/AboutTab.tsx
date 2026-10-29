// About & updates: version, automatic updates from the team server, and (for the host) sharing a new version.
import { useEffect, useState } from 'react'
import { sys, updates } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button, Field } from '../components/ui'
import { fmtDateTime, isMac } from '../util'

export function AboutTab() {
  const { settings, updateSettings, update, team, toast } = useApp()
  const [info, setInfo] = useState<{ version: string; userData: string } | null>(null)
  const [url, setUrl] = useState(settings.updates.url)
  const [version, setVersion] = useState('')
  const [folder, setFolder] = useState('')
  useEffect(() => {
    sys.appInfo().then(setInfo)
    updates.folder().then(setFolder).catch(() => {})
  }, [])
  const u = update
  const stateText: Record<string, string> = {
    disabled: 'Automatic updates are off (or there is no update address yet).',
    idle: 'Waiting to check for updates.',
    checking: 'Checking for updates...',
    downloading: `Downloading version ${u?.version ?? ''}... ${u?.progress ?? 0}%`,
    ready: `Version ${u?.version} is ready. Restart BidMail to finish updating.`,
    current: 'BidMail is up to date.',
    error: `Couldn't check for updates: ${u?.error ?? ''}`
  }
  return (
    <div className="settings-stack">
      <div className="card form-card">
        <h3>BidMail {info?.version}</h3>
        <p className="muted">Email and bid-invitation tracking for construction estimators.</p>
        {info && (
          <p>
            Your data folder: <span className="mono">{info.userData}</span>{' '}
            <button className="link-btn" onClick={() => sys.openPath(info.userData)}>Open</button>
          </p>
        )}
        <p className="muted small">Passwords and sign-ins are encrypted with {isMac ? 'the macOS Keychain' : "Windows' built-in protection (DPAPI)"} and never leave this computer.</p>
      </div>

      <div className="card form-card">
        <h3>Updates</h3>
        <div className={u?.state === 'error' ? 'warn-box' : u?.state === 'ready' ? 'ok-box' : 'muted'}>
          {u?.state === 'ready' && <Icon name="download" />} {stateText[u?.state ?? 'disabled']}
          {u?.checkedAt && <span className="small"> (checked {fmtDateTime(u.checkedAt)})</span>}
        </div>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          {u?.state === 'ready' ? (
            <Button kind="primary" icon="refresh" onClick={() => updates.install()}>Restart to update</Button>
          ) : (
            <Button icon="refresh" disabled={!u || u.state === 'disabled' || u.state === 'checking' || u.state === 'downloading'} onClick={() => updates.check()}>Check now</Button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.updates.enabled} onChange={(e) => updateSettings({ updates: { ...settings.updates, enabled: e.target.checked } })} />
          Download new versions automatically
        </label>
        <Field label="Update address" hint={team?.mode === 'remote' ? 'Leave blank to get updates from your team server.' : 'A web folder with latest.yml. Leave blank when connected to a team server.'}>
          <div className="input-with-btn">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={team?.mode === 'remote' ? `${settings.team.url}/updates` : 'https://'} />
            <Button onClick={() => updateSettings({ updates: { ...settings.updates, url: url.trim() } }).then(() => toast('Saved', 'success'))}>Save</Button>
          </div>
        </Field>
        {isMac && <p className="muted small">On a Mac, automatic updates require an app signed with an Apple Developer ID. Until then, install new versions from the .dmg.</p>}
      </div>

      {team?.mode === 'host' && (
        <div className="card form-card">
          <h3>Share a new version with your team</h3>
          <p className="muted">Choose the new installer (BidMail Setup x.y.z.exe, or the Mac .zip). Teammates connected to this computer download it automatically and are offered "Restart to update".</p>
          <div className="form-grid narrow">
            <Field label="Version number"><input value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="1.1.0" /></Field>
            <Button
              kind="primary"
              icon="upload"
              disabled={!/^\d+\.\d+\.\d+/.test(version)}
              onClick={() => updates.publish(version).then((p) => p && toast('Published. Teammates will get version ' + version, 'success')).catch((e) => toast(e.message, 'error'))}
            >
              Choose installer...
            </Button>
          </div>
          {folder && <p className="muted small">Updates folder: <span className="mono">{folder}</span></p>}
        </div>
      )}
    </div>
  )
}