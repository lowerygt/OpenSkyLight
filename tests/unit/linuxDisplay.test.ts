import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Cb = (err: Error | null) => void
const cpMock = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ ...cpMock, default: cpMock }))

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: false },
  dialog: {},
  net: {},
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => true) },
  protocol: { handle: vi.fn() }
}))
vi.mock('electron', () => electronMock)

import { panelOff, panelOn } from '../../src/main/kiosk/linuxDisplay'
import { createKiosk } from '../../src/main/kiosk/kiosk'

const realPlatform = process.platform
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
const ok = (_c: string, _a: string[], _o: unknown, cb: Cb) => cb(null)
const xsetCalls = () => cpMock.execFile.mock.calls.map((c) => `${c[0]} ${(c[1] as string[]).join(' ')}`)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  cpMock.execFile.mockImplementation(ok)
})
afterEach(() => {
  vi.useRealTimers()
  setPlatform(realPlatform)
})

describe('linux panel power', () => {
  it('turns the panel off and on with xset', async () => {
    expect(await panelOff()).toBe(true)
    expect(await panelOn()).toBe(true)
    expect(xsetCalls()).toEqual(['xset dpms force off', 'xset dpms force on', 'xset s reset'])
  })
  it('survives xset missing (ENOENT) or failing (Wayland)', async () => {
    cpMock.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Cb) =>
      cb(Object.assign(new Error('spawn xset ENOENT'), { code: 'ENOENT' }))
    )
    await expect(panelOff()).resolves.toBe(false)
    await expect(panelOn()).resolves.toBe(false)
  })
  it('survives execFile throwing synchronously', async () => {
    cpMock.execFile.mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(panelOff()).resolves.toBe(false)
  })
})

describe('kiosk sleep window drives the panel', () => {
  function sleepKiosk(enabled: { v: boolean }) {
    const settings = {
      getAll: () => ({ screensaver: { folder: null, idleMinutes: 5 }, sleep: { enabled: enabled.v, start: '00:00', end: '23:59' } })
    } as never
    return createKiosk({ settings, broadcast: () => {} })
  }

  it('on Linux: off when sleeping, on after a touch, off again after the override, on when the window ends', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 15, 12, 0) })
    setPlatform('linux')
    const enabled = { v: true }
    const kiosk = sleepKiosk(enabled)
    kiosk.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(xsetCalls()).toEqual(['xset dpms force off'])
    kiosk.reportActivity()
    await vi.advanceTimersByTimeAsync(0)
    expect(xsetCalls().slice(1)).toEqual(['xset dpms force on', 'xset s reset'])
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(xsetCalls().at(-1)).toBe('xset dpms force off')
    enabled.v = false
    await vi.advanceTimersByTimeAsync(5_000)
    expect(xsetCalls().slice(-2)).toEqual(['xset dpms force on', 'xset s reset'])
    kiosk.stop()
  })

  it('on Windows never calls xset', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 15, 12, 0) })
    setPlatform('win32')
    const kiosk = sleepKiosk({ v: true })
    kiosk.start()
    await vi.advanceTimersByTimeAsync(5_000)
    kiosk.reportActivity()
    expect(cpMock.execFile).not.toHaveBeenCalled()
    kiosk.stop()
  })
})
