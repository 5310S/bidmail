// Minimal stand-in for the Electron APIs used by main-process modules.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bidmail-test-'))

export const app = {
  getPath: (name: string) => {
    const p = path.join(base, name)
    fs.mkdirSync(p, { recursive: true })
    return p
  },
  getVersion: () => 'test'
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString()
}