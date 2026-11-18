import { afterEach, describe, expect, it, vi } from 'vitest'

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret')
}))
vi.mock('electron', () => ({ safeStorage }))

import { secretsStoredAsPlainText } from '../../src/main/secretStorage'

const realPlatform = process.platform
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
afterEach(() => setPlatform(realPlatform))

describe('secretsStoredAsPlainText', () => {
  it('is false on Linux with a keyring', () => {
    setPlatform('linux')
    expect(secretsStoredAsPlainText()).toBe(false)
  })
  it('is true on Linux with the basic_text fallback', () => {
    setPlatform('linux')
    safeStorage.getSelectedStorageBackend.mockReturnValueOnce('basic_text')
    expect(secretsStoredAsPlainText()).toBe(true)
  })
  it('is true on Linux when encryption is unavailable or the check throws', () => {
    setPlatform('linux')
    safeStorage.isEncryptionAvailable.mockReturnValueOnce(false)
    expect(secretsStoredAsPlainText()).toBe(true)
    safeStorage.isEncryptionAvailable.mockImplementationOnce(() => {
      throw new Error('not ready')
    })
    expect(secretsStoredAsPlainText()).toBe(true)
  })
  it('never warns on Windows', () => {
    setPlatform('win32')
    safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text')
    expect(secretsStoredAsPlainText()).toBe(false)
  })
})
