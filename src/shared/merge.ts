import { Addendum, Bidder, escapeHtml, Job, Trade } from './types'

export function formatBidDue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  })
}

/** Sign-off added to bulk emails: the account signature, or name + company when none is set. */
export function signOff(signature: string, me: { name: string; company: string }): string {
  if (signature.trim()) return signature
  const lines = [me.name, me.company].filter((x) => x.trim()).map(escapeHtml)
  return lines.length ? `<p>${lines.join('<br>')}</p>` : ''
}

/** Values for the {{merge_fields}} used in bid invitation and follow-up templates. */
export function mergeFields(job: Job, trade: Trade, bidder: Bidder, me: { name: string; company: string }, addendum?: Addendum | null): Record<string, string> {
  const contact = bidder.contactName.trim()
  return {
    first_name: contact.split(/\s+/)[0] ?? '',
    contact_name: contact,
    company: bidder.companyName,
    trade: trade.name,
    job_name: job.name,
    job_number: job.number,
    job_location: job.location,
    client: job.client,
    bid_due: formatBidDue(job.bidDue),
    // A trade with its own drawing package uses its own links.
    drawings_link: trade.drawingsLink || job.drawingsLink,
    specs_link: trade.specsLink || job.specsLink,
    trade_scope: trade.scopeNote ?? '',
    addendum_number: addendum?.number ?? '',
    addendum_title: addendum?.title ?? '',
    addendum_link: addendum?.link ?? '',
    addendum_description: addendum?.description ?? '',
    my_name: me.name,
    my_company: me.company
  }
}