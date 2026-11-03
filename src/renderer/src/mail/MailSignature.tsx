// Shows the Mac Mail signature an account sends with (Mail adds it when sending, so it is not part of the body).
import { useCallback, useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { mailAddsSignature, type MailAccount } from '../../../shared/ipc'
import { accounts as accountsApi } from '../api'

/**
 * The account's Mail signature as safe HTML ('' when Mail adds none). `exact` is false while only its text is known:
 * its pictures come from a sent email that carries it.
 */
export function useMailSignature(account?: MailAccount | null) {
  const on = mailAddsSignature(account)
  const [html, setHtml] = useState('')
  const [exact, setExact] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(
    (refresh: boolean) => {
      if (!account || !on) return setHtml('')
      setLoading(true)
      setError('')
      accountsApi
        .mailSignatureHtml(account, refresh)
        .then((s) => {
          setHtml(DOMPurify.sanitize(s.html))
          setExact(s.exact)
        })
        .catch((e) => setError(e?.message ?? String(e)))
        .finally(() => setLoading(false))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [on, account?.appleMailSignature, account?.appleMailAccount, account?.email]
  )
  useEffect(() => load(false), [load])
  return { html, exact, loading, error, refresh: () => load(true) }
}

/** The signature itself, or what is happening while it is fetched. */
export function MailSignatureBody({ account, sig }: { account: MailAccount; sig: ReturnType<typeof useMailSignature> }) {
  if (sig.loading && !sig.html) return <div className="muted small">Getting "{account.appleMailSignature}" from Mail...</div>
  if (sig.error) return <div className="muted small">Couldn't show "{account.appleMailSignature}": {sig.error}. Mail still adds it when sending.</div>
  return (
    <>
      <div className="mail-sig-body" dangerouslySetInnerHTML={{ __html: sig.html }} />
      {!sig.exact && <div className="muted small" style={{ marginTop: 6 }}>Pictures in it show here once you've sent an email with it. Mail adds them when sending.</div>}
    </>
  )
}

export function MailSignaturePreview({ account }: { account: MailAccount }) {
  const sig = useMailSignature(account)
  return (
    <div className="mail-sig" contentEditable={false}>
      <div className="mail-sig-label">Signature from Mac Mail, added when sent</div>
      <MailSignatureBody account={account} sig={sig} />
    </div>
  )
}
