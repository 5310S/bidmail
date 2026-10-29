// Automatic updates, end to end: the packaged app finds a newer version on a team server's /updates
// folder and downloads it. (Installing is disabled for the test with BIDMAIL_NO_AUTO_INSTALL.)
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { _electron as electron } from 'playwright-core'
import { BidStore } from '../src/shared/store'
import { startTeamServer } from '../src/shared/teamServer'
import { publishInstaller } from '../src/main/updatesFeed'

const root = path.resolve(__dirname, '..', '..', '..')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const installer = path.join(root, 'release', 'BidMail-Setup-1.1.0.exe')
  const exe = path.join(root, 'release', 'win-unpacked', 'BidMail.exe')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmail-upd-'))
  const updatesDir = path.join(work, 'updates')
  publishInstaller(installer, '9.9.9', updatesDir)
  const store = new BidStore(path.join(work, 'team.db'))
  const srv = await startTeamServer({ store, port: 0, key: 'k', host: '127.0.0.1', updatesDir })
  const data = path.join(work, 'data')
  fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ userName: 'Tester', updates: { url: `http://127.0.0.1:${srv.port}/updates`, enabled: true } }))
  const app = await electron.launch({ executablePath: exe, args: [], env: { ...process.env, BIDMAIL_DATA_DIR: data, BIDMAIL_NO_AUTO_INSTALL: '1' } })
  let status: any = null
  try {
    const page = await app.firstWindow()
    for (let i = 0; i < 180; i++) {
      status = await page.evaluate(() => window.bidmail.invoke('update:status'))
      if (status.state === 'ready' || status.state === 'error') break
      await sleep(1000)
    }
  } finally {
    await app.close()
    await srv.close()
    store.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
  console.log('update status:', JSON.stringify(status))
  if (status?.state !== 'ready' || status.version !== '9.9.9') throw new Error('update was not downloaded')
  console.log('Automatic update OK: found version 9.9.9 and downloaded it')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})