// Standalone BidMail Team Server.
// Run on an office PC or any cloud machine with Node.js 22.13+:
//   node bidmail-server.js --port 4780 --key SETUP-KEY --db ./bidmail-team.db --https --updates ./updates
// Environment variables PORT, BIDMAIL_KEY, BIDMAIL_DB, BIDMAIL_UPDATES work too.
//   --https                  use a self-signed certificate (saved next to the database)
//   --tls-cert F --tls-key F use your own certificate (e.g. from Let's Encrypt)
//   --updates DIR            host app installers for automatic updates
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { BidStore } from '../src/shared/store'
import { startTeamServer } from '../src/shared/teamServer'
import { fingerprintOf, loadOrCreateCert } from '../src/shared/cert'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

async function main() {
  const port = Number(arg('port') ?? process.env.PORT ?? 4780)
  let key = arg('key') ?? process.env.BIDMAIL_KEY ?? ''
  const db = path.resolve(arg('db') ?? process.env.BIDMAIL_DB ?? 'bidmail-team.db')
  const updatesArg = arg('updates') ?? process.env.BIDMAIL_UPDATES
  const updatesDir = updatesArg ? path.resolve(updatesArg) : undefined
  if (updatesDir) fs.mkdirSync(updatesDir, { recursive: true })
  if (!key) {
    key = randomBytes(9).toString('base64url')
    console.log(`No --key given. Generated setup key: ${key}`)
  }
  let tls: { key: string; cert: string } | undefined
  let fingerprint = ''
  if (arg('tls-cert') && arg('tls-key')) {
    tls = { cert: fs.readFileSync(arg('tls-cert')!, 'utf8'), key: fs.readFileSync(arg('tls-key')!, 'utf8') }
    fingerprint = fingerprintOf(tls.cert)
  } else if (flag('https')) {
    const t = await loadOrCreateCert(db.replace(/\.db$/i, '') + '-cert.json')
    tls = { key: t.key, cert: t.cert }
    fingerprint = t.fingerprint
  }
  const store = new BidStore(db)
  const srv = await startTeamServer({ store, port, key, tls, updatesDir, log: (m) => console.log(new Date().toLocaleString(), m) })
  console.log('BidMail Team Server running')
  console.log(`  Database:  ${db}`)
  console.log(`  Setup key: ${key}`)
  if (fingerprint) console.log(`  HTTPS certificate fingerprint (teammates should see the same): ${fingerprint}`)
  if (updatesDir) console.log(`  Updates folder: ${updatesDir}  (copy latest.yml + the installer here)`)
  if (store.userCount() === 0) console.log('  First time: in BidMail go to Settings > Team Sharing > Connect, enter the address and the setup key to create the admin account.')
  console.log('  Teammates connect to:')
  for (const a of srv.addresses) console.log(`    ${a}`)
  const stop = async () => {
    await srv.close()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})