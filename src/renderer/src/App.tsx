import { useApp } from './state'
import { Sidebar } from './components/Sidebar'
import { MailView } from './mail/MailView'
import { UnifiedInbox } from './mail/UnifiedInbox'
import { Composer } from './mail/Composer'
import { JobsView } from './jobs/JobsView'
import { JobView } from './jobs/JobView'
import { TodayView } from './today/TodayView'
import { CompaniesView } from './companies/CompaniesView'
import { TemplatesView } from './templates/TemplatesView'
import { SettingsView } from './settings/SettingsView'
import { Empty, Button } from './components/ui'

export function App() {
  const { view, composeState, accounts, go } = useApp()
  const mailView = view.kind === 'mail' ? view : null
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {mailView && accounts.some((a) => a.id === mailView.accountId) && (
          <MailView accountId={mailView.accountId} folder={mailView.folder} active />
        )}
        {mailView && !accounts.some((a) => a.id === mailView.accountId) && (
          <div className="page">
            <Empty icon="mail" title="Add your email account">
              <Button kind="primary" onClick={() => go({ kind: 'settings', tab: 'accounts' })}>Add account</Button>
            </Empty>
          </div>
        )}
        {view.kind === 'unified' && <UnifiedInbox />}
        {view.kind === 'today' && <TodayView />}
        {view.kind === 'jobs' && <JobsView />}
        {view.kind === 'job' && <JobView key={view.jobId} jobId={view.jobId} initialTab={view.tab} />}
        {view.kind === 'companies' && <CompaniesView />}
        {view.kind === 'templates' && <TemplatesView />}
        {view.kind === 'settings' && <SettingsView tab={view.tab} />}
      </main>
      {composeState && <Composer />}
    </div>
  )
}