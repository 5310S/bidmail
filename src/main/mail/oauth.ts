// "Sign in with Microsoft / Google" for mail accounts: OAuth 2.0 authorization code flow with PKCE,
// in the user's own browser, returning to a temporary loopback address on this computer (RFC 8252).
// BidMail only ever receives tokens; the password goes to Microsoft/Google directly.
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export type OAuthProviderId = 'microsoft' | 'google'

export interface OAuthProvider {
  id: OAuthProviderId
  label: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: string
  clientSecret?: string
  extraAuthParams?: Record<string, string>
  /** Host name used in the redirect address ("localhost" for Microsoft, "127.0.0.1" for Google). */
  redirectHost: string
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
}

import type { OAuthSettings } from '../../shared/ipc'

export const DEFAULT_OAUTH: OAuthSettings = { microsoftClientId: '', microsoftTenant: 'common', googleClientId: '', googleClientSecret: '' }

export function providerFor(id: OAuthProviderId, s: OAuthSettings): OAuthProvider {
  if (id === 'microsoft') {
    const tenant = (s.microsoftTenant || 'common').trim()
    return {
      id, label: 'Microsoft',
      authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scopes: ['openid', 'email', 'profile', 'offline_access', 'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send'],
      clientId: s.microsoftClientId.trim(),
      extraAuthParams: { prompt: 'select_account' },
      redirectHost: 'localhost',
      imap: { host: 'outlook.office365.com', port: 993, secure: true },
      smtp: { host: 'smtp.office365.com', port: 587, secure: false }
    }
  }
  return {
    id, label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'profile', 'https://mail.google.com/'],
    clientId: s.googleClientId.trim(),
    clientSecret: s.googleClientSecret.trim() || undefined,
    extraAuthParams: { access_type: 'offline', prompt: 'consent select_account' },
    redirectHost: '127.0.0.1',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true }
  }
}

export interface OAuthResult {
  email: string
  name: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const b64url = (b: Buffer) => b.toString('base64url')

function decodeJwt(token: string | undefined): Record<string, any> {
  if (!token) return {}
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

async function postForm(url: string, form: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30000)
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    const err = new Error(oauthMessage(body.error, body.error_description)) as Error & { code?: string }
    err.code = body.error
    throw err
  }
  return body
}

export function oauthMessage(code?: string, description?: string): string {
  if (code === 'invalid_grant') return 'Your sign-in has expired or was revoked. Sign in again in Settings > Email Accounts.'
  if (code === 'invalid_client' || code === 'unauthorized_client') return 'The sign-in app registration is not set up correctly (check the client ID in Settings > Email Accounts > Sign-in setup).'
  if (code === 'access_denied') return 'Sign-in was cancelled or not allowed by your organization.'
  return description?.split('\r\n')[0] || code || 'Sign-in failed'
}

/** Runs the browser sign-in. `openBrowser` opens the given URL (shell.openExternal in the app). */
export async function signIn(p: OAuthProvider, openBrowser: (url: string) => Promise<unknown>, timeoutMs = 5 * 60000): Promise<OAuthResult> {
  if (!p.clientId) throw new Error(`${p.label} sign-in needs a client ID first (Settings > Email Accounts > Sign-in setup).`)
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const servers: http.Server[] = []
  let resolveCode!: (code: string) => void
  let rejectCode!: (e: Error) => void
  const gotCode = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  const page = (title: string, msg: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#18202b"><div style="text-align:center"><h2>${title}</h2><p>${msg}</p></div>`
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      return res.end()
    }
    const err = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (err) {
      res.end(page('Sign-in did not finish', 'You can close this tab and try again in BidMail.'))
      return rejectCode(new Error(oauthMessage(err, url.searchParams.get('error_description') ?? undefined)))
    }
    if (url.searchParams.get('state') !== state) {
      res.end(page('Sign-in did not finish', 'This sign-in link was not started by BidMail. Close this tab and try again.'))
      return rejectCode(new Error('Sign-in was not started by BidMail (state mismatch).'))
    }
    res.end(page('You are signed in', 'You can close this tab and go back to BidMail.'))
    resolveCode(url.searchParams.get('code') ?? '')
  }
  const listen = (host: string, port: number) =>
    new Promise<number>((res, rej) => {
      const s = http.createServer(handler)
      s.once('error', rej)
      s.listen(port, host, () => {
        servers.push(s)
        res((s.address() as AddressInfo).port)
      })
    })
  const port = await listen('127.0.0.1', 0)
  await listen('::1', port).catch(() => {}) // "localhost" may resolve to IPv6 in some browsers
  const redirectUri = `http://${p.redirectHost}:${port}/callback`
  const close = () => servers.forEach((s) => s.close())
  const timer = setTimeout(() => rejectCode(new Error('Sign-in timed out. Try again.')), timeoutMs)

  try {
    const auth = new URL(p.authUrl)
    const params: Record<string, string> = {
      client_id: p.clientId, response_type: 'code', redirect_uri: redirectUri, scope: p.scopes.join(' '),
      state, code_challenge: challenge, code_challenge_method: 'S256', ...(p.extraAuthParams ?? {})
    }
    for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v)
    await openBrowser(auth.toString())
    const code = await gotCode
    const tok = await postForm(p.tokenUrl, {
      client_id: p.clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
      ...(p.clientSecret ? { client_secret: p.clientSecret } : {})
    })
    if (!tok.refresh_token) throw new Error('The provider did not return a long-term sign-in (refresh token). Try again.')
    const claims = decodeJwt(tok.id_token)
    const email = String(claims.email || claims.preferred_username || claims.upn || '').toLowerCase()
    if (!email.includes('@')) throw new Error('Could not read your email address from the sign-in.')
    return {
      email,
      name: String(claims.name ?? ''),
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + Number(tok.expires_in ?? 3600) * 1000
    }
  } finally {
    clearTimeout(timer)
    close()
  }
}

/** Exchanges a refresh token for a fresh access token (they last about an hour). */
export async function refresh(p: OAuthProvider, refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const tok = await postForm(p.tokenUrl, {
    client_id: p.clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: p.scopes.join(' '),
    ...(p.clientSecret ? { client_secret: p.clientSecret } : {})
  })
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || refreshToken,
    expiresAt: Date.now() + Number(tok.expires_in ?? 3600) * 1000
  }
}