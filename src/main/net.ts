// HTTP(S) client for the team server. Supports pinning a self-signed certificate: when `pinPem` is given,
// only that exact certificate is trusted (host name checks are skipped because the pin is stronger).
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'

export interface ReqOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  pinPem?: string
  timeoutMs?: number
  signal?: AbortSignal
}

function options(url: URL, o: ReqOptions): https.RequestOptions {
  const base: https.RequestOptions = {
    method: o.method ?? 'GET',
    headers: { ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(o.headers ?? {}) },
    signal: o.signal
  }
  if (url.protocol === 'https:' && o.pinPem) {
    base.ca = o.pinPem
    base.checkServerIdentity = () => undefined
  }
  return base
}

export class NetError extends Error {
  constructor(message: string, public code: string, public status = 0, public body: any = null) {
    super(message)
  }
}

/** JSON request. Resolves with status + parsed body for any HTTP status; rejects on network/TLS failure. */
export function request(urlStr: string, o: ReqOptions = {}): Promise<{ status: number; body: any }> {
  const url = new URL(urlStr)
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(url, options(url, o), (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: any = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = text
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
      res.on('error', reject)
    })
    req.setTimeout(o.timeoutMs ?? 20000, () => req.destroy(new NetError('The team server did not answer in time.', 'ETIMEDOUT')))
    req.on('error', (e: any) => reject(e instanceof NetError ? e : new NetError(describeNetError(e), e?.code ?? 'ENET')))
    if (o.body !== undefined) req.write(JSON.stringify(o.body))
    req.end()
  })
}

/** Opens a streaming GET (Server-Sent Events). Calls onText for each chunk; resolves when the stream ends. */
export function stream(urlStr: string, o: ReqOptions, onStatus: (status: number) => void, onText: (t: string) => void): Promise<void> {
  const url = new URL(urlStr)
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(url, options(url, o), (res) => {
      onStatus(res.statusCode ?? 0)
      res.setEncoding('utf8')
      res.on('data', (t: string) => onText(t))
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', (e: any) => reject(new NetError(describeNetError(e), e?.code ?? 'ENET')))
    req.end()
  })
}

export interface ServerCert {
  pem: string
  fingerprint: string
  subject: string
  validTo: string
  /** True when the certificate is already trusted by the operating system (e.g. Let's Encrypt). */
  trusted: boolean
}

/** Reads the certificate an HTTPS server presents, without trusting it, so the user can decide. */
export function fetchCertificate(urlStr: string): Promise<ServerCert> {
  const url = new URL(urlStr)
  const port = Number(url.port || 443)
  const isIp = /^[\d.]+$|:/.test(url.hostname)
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: url.hostname, port, servername: isIp ? undefined : url.hostname, rejectUnauthorized: false }, () => {
      const peer = sock.getPeerCertificate(true)
      sock.end()
      if (!peer?.raw) return reject(new NetError('The server did not present a certificate.', 'ENOCERT'))
      const b64 = peer.raw.toString('base64').match(/.{1,64}/g)!.join('\n')
      const pem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
      const x = new X509Certificate(pem)
      resolve({ pem, fingerprint: x.fingerprint256, subject: x.subject.replace(/\n/g, ', '), validTo: x.validTo, trusted: sock.authorized })
    })
    sock.setTimeout(8000, () => sock.destroy(new NetError('No answer from ' + url.host, 'ETIMEDOUT')))
    sock.on('error', (e: any) => reject(new NetError(describeNetError(e), e?.code ?? 'ENET')))
  })
}

export function describeNetError(e: any): string {
  const code = e?.code ?? e?.cause?.code
  if (code === 'ECONNREFUSED') return 'The team server refused the connection (is it running?).'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The team server address was not found.'
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'The team server could not be reached.'
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'CERT_SIGNATURE_FAILURE' || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
    return "The team server's security certificate is not the one you trusted. If the server was reinstalled, trust its new certificate in Settings > Team Sharing."
  return e?.message ?? String(e)
}