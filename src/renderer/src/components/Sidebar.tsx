import { useState } from 'react'
import { useApp } from '../state'
import { Icon } from './Icon'
import { cx, dueInfo } from '../util'
import { invoke } from '../api'
import type { MailFolder } from '../../../shared/ipc'

export function folderIcon(f: MailFolder) {
  switch (f.specialUse) {
    case '\\Inbox': return 'inbox'
    case '\\Sent': return 'send'
    case '\\Drafts': return 'file'
    case '\\Trash': return 'trash'
    case '\\Junk': return 'alert'
    case '\\Archive':
    case '\\All': return 'archive'
    case '\\Flagged': return 'star'
    default: return 'folder'
  }
}

export function Sidebar() {
  const { accounts, folders, folderErrors, view, go, compose, jobs, team, accountOnline, today, update } = useApp()
  const todayCount = (today?.followUps.length ?? 0) + (today?.addenda.filter((a) => a.notSent).length ?? 0)
  const unifiedUnread = accounts.reduce((n, a) => n + (folders[a.id]?.find((f) => f.specialUse === '\\Inbox')?.unseen ?? 0), 0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showAllFolders, setShowAllFolders] = useState<Record<string, boolean>>({})
  const activeJobs = jobs.filter((j) => j.status === 'bidding')
  // Job folders: bidding and submitted jobs (replies keep coming after a bid goes in).
  const openJobs = jobs.filter((j) => j.status === 'bidding' || j.status === 'submitted')

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">B</div>
        <div>
          <div className="brand-name">BidMail</div>
          <div className="brand-sub">Estimating Inbox</div>
        </div>
      </div>
      <button className="compose-btn" onClick={() => compose()}>
        <Icon name="pen" size={18} /> New Email
      </button>

      <div className="side-scroll">
        <div className="side-section">Bidding</div>
        <button className={cx('side-item', view.kind === 'today' && 'active')} onClick={() => go({ kind: 'today' })}>
          <Icon name="clock" /> <span className="grow">Today</span>
          {todayCount > 0 && <span className="count strong warn">{todayCount}</span>}
        </button>
        <button className={cx('side-item', view.kind === 'jobs' && 'active')} onClick={() => go({ kind: 'jobs' })}>
          <Icon name="briefcase" /> <span className="grow">All Jobs</span>
          <span className="count">{jobs.filter((j) => j.status === 'bidding').length || ''}</span>
        </button>
        {activeJobs.slice(0, 12).map((j) => {
          const due = dueInfo(j.bidDue)
          return (
            <button
              key={j.id}
              className={cx('side-item side-job', view.kind === 'job' && view.jobId === j.id && 'active')}
              onClick={() => go({ kind: 'job', jobId: j.id })}
              title={`${j.name}${j.bidDue ? ' - ' + due.label : ''}`}
            >
              <span className={cx('due-dot', `tone-${due.tone}`)} />
              <span className="grow ellipsis">{j.name}</span>
            </button>
          )
        })}
        <button className={cx('side-item', view.kind === 'companies' && 'active')} onClick={() => go({ kind: 'companies' })}>
          <Icon name="building" /> <span className="grow">Companies</span>
        </button>
        <button className={cx('side-item', view.kind === 'templates' && 'active')} onClick={() => go({ kind: 'templates' })}>
          <Icon name="template" /> <span className="grow">Email Templates</span>
        </button>

        <div className="side-section">Mail</div>
        {accounts.length > 1 && (
          <button className={cx('side-item', view.kind === 'unified' && 'active')} onClick={() => go({ kind: 'unified' })}>
            <Icon name="inbox" /> <span className="grow">All Inboxes</span>
            {unifiedUnread > 0 && <span className="count strong">{unifiedUnread}</span>}
          </button>
        )}
        {accounts.length === 0 && (
          <button className="side-item muted" onClick={() => go({ kind: 'settings', tab: 'accounts' })}>
            <Icon name="plus" /> <span className="grow">Add email account</span>
          </button>
        )}
        {accounts.map((a) => {
          const list = folders[a.id] ?? []
          const main = list.filter((f) => (f.specialUse && f.specialUse !== '\\All' && f.specialUse !== '\\Flagged') || f.name === 'Snoozed')
          const others = list.filter((f) => !main.includes(f))
          const shown = showAllFolders[a.id] ? list : main.length ? main : list.slice(0, 8)
          return (
            <div key={a.id} className="side-account">
              <button className="side-account-head" onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !c[a.id] }))}>
                <Icon name={collapsed[a.id] ? 'chevronRight' : 'chevronDown'} size={14} />
                <span className="acct-dot" style={{ background: a.color || '#2f6fdb' }} />
                <span className="grow ellipsis" title={a.email}>{a.displayName || a.email}</span>
                {accountOnline[a.id] === false && <Icon name="wifiOff" size={14} title="Offline - retrying" />}
              </button>
              {!collapsed[a.id] && (
                <>
                  {folderErrors[a.id] && (
                    <button className="side-item side-error" onClick={() => go({ kind: 'settings', tab: 'accounts' })} title={folderErrors[a.id]}>
                      <Icon name="alert" /> <span className="grow ellipsis">Can't connect</span>
                    </button>
                  )}
                  {shown.map((f) => (
                    <button
                      key={f.path}
                      className={cx('side-item side-folder', view.kind === 'mail' && view.accountId === a.id && view.folder === f.path && 'active')}
                      style={{ paddingLeft: 30 + Math.min(f.depth, 4) * 12 }}
                      onClick={() => go({ kind: 'mail', accountId: a.id, folder: f.path })}
                    >
                      <Icon name={folderIcon(f)} size={16} />
                      <span className="grow ellipsis">{f.name}</span>
                      {f.unseen > 0 && f.specialUse !== '\\Sent' && f.specialUse !== '\\Trash' && (
                        <span className="count strong">{f.unseen}</span>
                      )}
                    </button>
                  ))}
                  {others.length > 0 && main.length > 0 && (
                    <button className="side-item side-more" onClick={() => setShowAllFolders((s) => ({ ...s, [a.id]: !s[a.id] }))}>
                      <span className="grow">{showAllFolders[a.id] ? 'Fewer folders' : `More folders (${others.length})`}</span>
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
        {accounts.length > 0 && openJobs.length > 0 && (
          <div className="side-account">
            <button className="side-account-head" onClick={() => setCollapsed((c) => ({ ...c, jobFolders: !c.jobFolders }))}>
              <Icon name={collapsed.jobFolders ? 'chevronRight' : 'chevronDown'} size={14} />
              <Icon name="briefcase" size={14} />
              <span className="grow ellipsis">Job Folders</span>
            </button>
            {!collapsed.jobFolders &&
              openJobs.map((j) => (
                <button
                  key={j.id}
                  className={cx('side-item side-folder', view.kind === 'job' && view.jobId === j.id && view.tab === 'email' && 'active')}
                  style={{ paddingLeft: 30 }}
                  onClick={() => go({ kind: 'job', jobId: j.id, tab: 'email' })}
                  title={`${j.name}: emails to and from this job's companies`}
                >
                  <Icon name="folder" size={16} />
                  <span className="grow ellipsis">{j.name}</span>
                </button>
              ))}
          </div>
        )}
      </div>

      <div className="side-foot">
        {update?.state === 'ready' && (
          <button className="update-pill" onClick={() => invoke('update:install')} title={`Version ${update.version} is downloaded. BidMail closes and opens again on the new version.`}>
            <Icon name="refresh" size={15} /> <span className="ellipsis">Relaunch to Update</span>
          </button>
        )}
        <button
          className={cx('team-pill', team?.mode !== 'local' && (team?.connected ? 'ok' : 'bad'))}
          onClick={() => go({ kind: 'settings', tab: 'team' })}
          title={team?.error || ''}
        >
          <Icon name={team?.mode === 'local' ? 'users' : team?.connected ? 'wifi' : 'wifiOff'} size={15} />
          <span className="ellipsis">
            {team?.mode === 'local'
              ? 'Local data (not shared)'
              : team?.mode === 'host'
                ? 'Hosting team data'
                : team?.needsLogin
                  ? 'Sign in to your team'
                  : team?.connected
                    ? `Team: ${team.user?.displayName ?? 'connected'}`
                    : 'Team offline'}
          </span>
        </button>
        <button className={cx('side-item', view.kind === 'settings' && 'active')} onClick={() => go({ kind: 'settings' })}>
          <Icon name="settings" /> <span className="grow">Settings</span>
        </button>
      </div>
    </aside>
  )
}