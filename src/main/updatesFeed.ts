import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Publishes an installer for teammates: copies it into the updates folder and writes the
 * latest.yml (Windows .exe) or latest-mac.yml (Mac .zip) file that the updater reads.
 */
export function publishInstaller(installer: string, version: string, updatesDir: string): string {
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Enter the version number, like 1.2.0.')
  const ext = path.extname(installer).toLowerCase()
  if (ext !== '.exe' && ext !== '.zip') throw new Error('Choose the Windows installer (.exe) or the Mac .zip.')
  fs.mkdirSync(updatesDir, { recursive: true })
  const name = path.basename(installer).replace(/\s+/g, '-')
  const target = path.join(updatesDir, name)
  if (path.resolve(installer) !== path.resolve(target)) fs.copyFileSync(installer, target)
  const data = fs.readFileSync(target)
  const sha512 = createHash('sha512').update(data).digest('base64')
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${data.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n')
  const ymlName = ext === '.zip' ? 'latest-mac.yml' : 'latest.yml'
  fs.writeFileSync(path.join(updatesDir, ymlName), yml)
  return path.join(updatesDir, ymlName)
}