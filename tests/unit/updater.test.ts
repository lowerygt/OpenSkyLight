import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const autoUpdater = vi.hoisted(() => ({
  on: vi.fn(),
  checkForUpdates: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn(),
  autoDownload: false,
  autoInstallOnAppQuit: false
}))
vi.mock('electron-updater', () => ({ autoUpdater }))
vi.mock('electron', () => ({ app: { isPackaged: true } }))

import { createUpdater } from '../../src/main/updater'

const realPlatform = process.platform
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  setPlatform(realPlatform)
})

describe('updater', () => {
  it('does nothing on Linux', () => {
    setPlatform('linux')
    createUpdater({ broadcast: () => {} }).start()
    vi.advanceTimersByTime(60_000)
    expect(autoUpdater.on).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })
  it('checks for updates on Windows', () => {
    setPlatform('win32')
    createUpdater({ broadcast: () => {} }).start()
    vi.advanceTimersByTime(30_000)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})
