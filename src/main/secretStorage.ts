import { safeStorage } from 'electron'

/**
 * True when secrets (Google tokens, camera URLs) end up effectively in plain text.
 * On Linux without a keyring (gnome-keyring / KWallet), safeStorage falls back to
 * the 'basic_text' backend; the user chose to allow that with a warning in Settings.
 */
export function secretsStoredAsPlainText(): boolean {
  if (process.platform !== 'linux') return false
  try {
    return !safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() === 'basic_text'
  } catch {
    return true
  }
}
