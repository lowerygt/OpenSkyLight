import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => [])
}))
vi.mock('node:fs', () => ({ ...fsMock, default: fsMock }))

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: true, setLoginItemSettings: vi.fn() },
  dialog: {},
  net: {},
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => true) },
  protocol: { handle: vi.fn() }
}))
vi.mock('electron', () => electronMock)

import { autostartEntry, autostartPath, isLinuxAutostartEnabled, setLinuxAutostart } from '../../src/main/kiosk/linuxAutostart'
import { createKiosk } from '../../src/main/kiosk/kiosk'

const realPlatform = process.platform
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.XDG_CONFIG_HOME = '/home/kiosk/.config'
})
afterEach(() => {
  setPlatform(realPlatform)
  delete process.env.XDG_CONFIG_HOME
})

describe('linux autostart entry', () => {
  it('lives in the XDG autostart folder', () => {
    expect(autostartPath()).toBe('/home/kiosk/.config/autostart/openskylight.desktop')
  })
  it('launches the executable and is enabled for GNOME-style sessions', () => {
    const entry = autostartEntry('/opt/OpenSkyLight/openskylight')
    expect(entry).toContain('Exec=/opt/OpenSkyLight/openskylight\n')
    expect(entry).toContain('X-GNOME-Autostart-enabled=true')
    expect(entry.startsWith('[Desktop Entry]\nType=Application')).toBe(true)
  })
  it('quotes paths with spaces', () => {
    expect(autostartEntry('/opt/Open Sky/app')).toContain('Exec="/opt/Open Sky/app"')
  })
  it('writes and removes the file', () => {
    setLinuxAutostart(true, '/opt/x')
    expect(fsMock.mkdirSync).toHaveBeenCalledWith('/home/kiosk/.config/autostart', { recursive: true })
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(autostartPath(), autostartEntry('/opt/x'), 'utf8')
    setLinuxAutostart(false, '/opt/x')
    expect(fsMock.rmSync).toHaveBeenCalledWith(autostartPath(), { force: true })
  })
  it('reads the setting from the file', () => {
    fsMock.existsSync.mockReturnValueOnce(true)
    expect(isLinuxAutostartEnabled()).toBe(true)
    expect(isLinuxAutostartEnabled()).toBe(false)
  })
})

describe('kiosk launch-on-startup by platform', () => {
  const settings = { getAll: () => ({}) } as never
  const kiosk = (): ReturnType<typeof createKiosk> => createKiosk({ settings, broadcast: () => {} })

  it('uses the autostart file on Linux', () => {
    setPlatform('linux')
    kiosk().setLaunchOnStartup(true)
    expect(fsMock.writeFileSync).toHaveBeenCalled()
    expect(electronMock.app.setLoginItemSettings).not.toHaveBeenCalled()
    fsMock.existsSync.mockReturnValueOnce(true)
    expect(kiosk().getLaunchOnStartup(false)).toBe(true)
  })
  it('keeps login items on Windows', () => {
    setPlatform('win32')
    kiosk().setLaunchOnStartup(true)
    expect(electronMock.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, path: process.execPath })
    expect(fsMock.writeFileSync).not.toHaveBeenCalled()
    expect(kiosk().getLaunchOnStartup(false)).toBe(false)
  })
})
