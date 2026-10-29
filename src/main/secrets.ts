// Encrypts secrets (mail passwords, team key) with the OS keychain (DPAPI on Windows, Keychain on macOS).
import { safeStorage } from 'electron'

export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(plain).toString('base64')
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64')
}

export function decryptSecret(stored: string | undefined): string {
  if (!stored) return ''
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8')
  } catch {
    return ''
  }
  return stored
}