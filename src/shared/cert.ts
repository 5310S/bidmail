// Self-signed TLS certificate for the team server (office network use). Teammates' apps pin this exact
// certificate the first time they connect, so nobody can impersonate the server later.
import fs from 'node:fs'
import os from 'node:os'
import { X509Certificate } from 'node:crypto'
import { generate } from 'selfsigned'

export interface TlsMaterial {
  key: string
  cert: string
  fingerprint: string
}

export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256
}

/** Loads the certificate saved at `file`, or creates one (valid 10 years) for this computer's names and addresses. */
export async function loadOrCreateCert(file: string): Promise<TlsMaterial> {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { key: string; cert: string }
    if (new Date(new X509Certificate(saved.cert).validTo).getTime() > Date.now() + 30 * 86400000) {
      return { ...saved, fingerprint: fingerprintOf(saved.cert) }
    }
  } catch {
    /* create a new one */
  }
  const ips = ['127.0.0.1']
  for (const list of Object.values(os.networkInterfaces())) for (const ni of list ?? []) if (ni.family === 'IPv4') ips.push(ni.address)
  const names = ['localhost', os.hostname()]
  const pems = await generate([{ name: 'commonName', value: `BidMail Team Server (${os.hostname()})` }], {
    keySize: 2048,
    notAfterDate: new Date(Date.now() + 3650 * 86400000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [...names.map((value) => ({ type: 2 as const, value })), ...[...new Set(ips)].map((ip) => ({ type: 7 as const, ip }))] }
    ]
  } as any)
  const out = { key: pems.private, cert: pems.cert }
  fs.writeFileSync(file, JSON.stringify(out), { mode: 0o600 })
  return { ...out, fingerprint: fingerprintOf(out.cert) }
}