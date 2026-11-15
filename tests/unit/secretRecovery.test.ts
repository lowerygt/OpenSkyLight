import { beforeEach, describe, expect, it, vi } from 'vitest'

// safeStorage that "lost its key": encrypt works, decrypt throws (keyring changed / profile moved)
const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf8').replace(/^enc:/, ''))
}))
vi.mock('electron', () => ({ safeStorage, shell: {}, app: { isPackaged: false } }))
vi.mock('ffmpeg-static', () => ({ default: null }))

import { openDatabase, type DbHandle } from '../../src/main/db/client'
import { createSettingsService } from '../../src/main/services/settingsService'
import { createGoogleAuth } from '../../src/main/sync/googleAuth'
import { createCameraService } from '../../src/main/services/cameraService'
import { googleAccounts } from '../../src/main/db/schema'

const breakDecrypt = (): void => {
  safeStorage.decryptString.mockImplementation(() => {
    throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
  })
}

let handle: DbHandle
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  safeStorage.decryptString.mockImplementation((b: Buffer) => b.toString('utf8').replace(/^enc:/, ''))
  handle = openDatabase(':memory:')
})

describe('google secrets that no longer decrypt', () => {
  it('clears the client secret and asks for re-entry', () => {
    const settings = createSettingsService(handle.db)
    const auth = createGoogleAuth(handle.db, settings)
    auth.setCredentials('client-id-123456', 'shh-secret')
    expect(auth.isConfigured()).toBe(true)
    breakDecrypt()
    expect(auth.isConfigured()).toBe(false)
    expect(auth.getNotice()).toMatch(/Enter it again/)
    expect(settings.getRaw('google.clientSecretEnc')).toBeNull()
    auth.setCredentials('client-id-123456', 'new-secret')
    expect(auth.getNotice()).toBeNull()
  })

  it('clears an unreadable refresh token and asks to reconnect, without crashing', () => {
    const settings = createSettingsService(handle.db)
    const auth = createGoogleAuth(handle.db, settings)
    auth.setCredentials('client-id-123456', 'shh-secret')
    handle.db
      .insert(googleAccounts)
      .values({ id: 'a1', email: 'kid@example.com', refreshTokenEnc: Buffer.from('enc:tok'), scopes: '', connectedAt: '2026-01-01T00:00:00Z' })
      .run()
    expect(() => auth.getAuthedClient('a1')).not.toThrow()
    // only the token is unreadable now
    safeStorage.decryptString.mockImplementation((b: Buffer) => {
      if (b.toString('utf8') === 'enc:tok') throw new Error('bad key')
      return b.toString('utf8').replace(/^enc:/, '')
    })
    expect(() => auth.getAuthedClient('a1')).toThrow(/Reconnect this account/)
    const [account] = auth.listAccounts()
    expect(account.error).toMatch(/Reconnect this account/)
    expect(() => auth.getAuthedClient('a1')).toThrow(/Reconnect this account/)
  })
})

describe('camera URLs that no longer decrypt', () => {
  it('clears the URL, flags the camera and refuses to stream with a clear message', async () => {
    const settings = createSettingsService(handle.db)
    const cams = createCameraService(settings)
    const cam = cams.add('Porch', 'rtsp://user:pw@cam/stream')
    expect(cams.list()).toEqual([{ id: cam.id, name: 'Porch', needsUrl: false }])
    breakDecrypt()
    expect(cams.list()).toEqual([{ id: cam.id, name: 'Porch', needsUrl: true }])
    expect(settings.getRaw('cameras.v1')).not.toContain('enc:')
    await expect(cams.start(cam.id)).rejects.toThrow(/add it again/)
    cams.shutdown()
  })
})
