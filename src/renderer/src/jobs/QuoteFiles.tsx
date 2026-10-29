// Quote files stored with a company on a job (shared with the team through the job's database).
import type { FileMeta } from '../../../shared/types'
import { bid, files } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Button } from '../components/ui'
import { fmtDateTime, fmtSize } from '../util'

export function QuoteFiles({ jobId, bidderId, list, compact }: { jobId: string; bidderId: string | null; list: FileMeta[]; compact?: boolean }) {
  const { toast, confirm } = useApp()
  const mine = list.filter((f) => f.bidderId === bidderId)
  return (
    <div className="quote-files">
      {mine.map((f) => (
        <span key={f.id} className="att-pill" title={`${f.name} · ${fmtSize(f.size)} · added ${fmtDateTime(f.createdAt)}${f.createdBy ? ' by ' + f.createdBy : ''}`}>
          <button className="link-btn" onClick={() => files.open(f.id).catch((e) => toast(e.message, 'error'))}>
            <Icon name="file" size={13} /> {f.name}
          </button>
          {!compact && (
            <button
              title="Remove"
              onClick={async () => {
                if (await confirm({ title: 'Remove file?', message: `Remove "${f.name}" from this job?` })) bid.deleteFile(f.id)
              }}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ))}
      {!compact && (
        <Button small icon="paperclip" onClick={() => files.addFromDisk(jobId, bidderId).then((r) => r.length && toast(`Attached ${r.length} file(s)`, 'success')).catch((e) => toast(e.message, 'error'))}>
          Attach quote
        </Button>
      )}
      {compact && !mine.length && <span className="muted small">none</span>}
    </div>
  )
}