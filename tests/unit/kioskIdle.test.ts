import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: false },
  dialog: {},
  net: {},
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => true) },
  protocol: { handle: vi.fn() }
}))
vi.mock('electron', () => electronMock)

import { createKiosk } from '../../src/main/kiosk/kiosk'
import { createActivityThrottle } from '../../src/shared/activityThrottle'

const realPlatform = process.platform
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}
const settings = {
  getAll: () => ({ screensaver: { folder: '/photos', idleMinutes: 1 }, sleep: { enabled: false } })
} as never

function makeKiosk() {
  const broadcast = vi.fn()
  const kiosk = createKiosk({ settings, broadcast })
  const states = () => broadcast.mock.calls.filter((c) => c[0] === 'push:kioskIdle').map((c) => c[1].state)
  return { kiosk, states }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  setPlatform(realPlatform)
})

describe('kiosk idle detection', () => {
  it('on Linux uses renderer-reported activity, not powerMonitor', () => {
    setPlatform('linux')
    const { kiosk, states } = makeKiosk()
    kiosk.start()
    vi.advanceTimersByTime(55_000)
    kiosk.reportActivity()
    vi.advanceTimersByTime(30_000)
    expect(states()).toEqual([])
    vi.advanceTimersByTime(35_000)
    expect(states()).toEqual(['screensaver'])
    kiosk.reportActivity()
    vi.advanceTimersByTime(5_000)
    expect(states()).toEqual(['screensaver', 'active'])
    expect(electronMock.powerMonitor.getSystemIdleTime).not.toHaveBeenCalled()
    kiosk.stop()
  })
  it('on Windows keeps using powerMonitor.getSystemIdleTime', () => {
    setPlatform('win32')
    electronMock.powerMonitor.getSystemIdleTime.mockReturnValue(120)
    const { kiosk, states } = makeKiosk()
    kiosk.start()
    vi.advanceTimersByTime(5_000)
    expect(states()).toEqual(['screensaver'])
    expect(electronMock.powerMonitor.getSystemIdleTime).toHaveBeenCalled()
    kiosk.stop()
  })
})

describe('createActivityThrottle', () => {
  it('sends the first event at once, then at most once per interval', () => {
    let t = 0
    const send = vi.fn()
    const report = createActivityThrottle(send, 3_000, () => t)
    report()
    report()
    t = 2_999
    report()
    expect(send).toHaveBeenCalledTimes(1)
    t = 3_000
    report()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
