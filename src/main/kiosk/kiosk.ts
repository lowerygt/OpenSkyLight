import { app, dialog, net, powerMonitor, powerSaveBlocker, protocol } from 'electron'
import { readdirSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DateTime } from 'luxon'
import type { SettingsService } from '../services/settingsService'
import { isInSleepWindow } from '@shared/sleepWindow'
import { isLinuxAutostartEnabled, setLinuxAutostart } from './linuxAutostart'
import { panelOff, panelOn } from './linuxDisplay'

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const IDLE_POLL_MS = 5_000
const SLEEP_POLL_MS = 5_000
/** Matches the renderer's tap-to-wake override during the sleep window. */
const WAKE_OVERRIDE_MS = 5 * 60 * 1000

export function createKiosk(deps: { settings: SettingsService; broadcast: (ch: string, p: unknown) => void }) {
  const { settings, broadcast } = deps
  let idleTimer: NodeJS.Timeout | null = null
  let sleepTimer: NodeJS.Timeout | null = null
  let screensaverOn = false
  let sleeping = false
  let blockerId: number | null = null
  // Linux: powerMonitor.getSystemIdleTime is unreliable (Wayland, some X11 setups), so the
  // renderer reports pointer/touch/key activity and idle time is measured from that.
  let lastActivity = Date.now()
  // Linux: the panel is switched off explicitly while sleeping; a touch turns it back on
  let panelIsOff = false
  let reSleepTimer: NodeJS.Timeout | null = null

  function setPanel(off: boolean): void {
    if (process.platform !== 'linux' || panelIsOff === off) return
    panelIsOff = off
    void (off ? panelOff() : panelOn())
  }

  function reportActivity(): void {
    lastActivity = Date.now()
    if (sleeping && panelIsOff) {
      setPanel(false)
      if (reSleepTimer) clearTimeout(reSleepTimer)
      reSleepTimer = setTimeout(() => sleeping && setPanel(true), WAKE_OVERRIDE_MS)
    }
  }

  function idleSeconds(): number {
    if (process.platform === 'linux') return Math.floor((Date.now() - lastActivity) / 1000)
    return powerMonitor.getSystemIdleTime()
  }

  /** Photos are served through osl-photo:// so the sandboxed renderer never touches the filesystem. */
  function registerPhotoProtocol(): void {
    protocol.handle('osl-photo', (request) => {
      const folder = settings.getAll().screensaver.folder
      if (!folder) return new Response('no folder', { status: 404 })
      const url = new URL(request.url)
      const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const full = resolve(join(folder, name))
      // path-traversal guard: the resolved file must stay inside the folder
      if (!full.startsWith(resolve(folder))) return new Response('forbidden', { status: 403 })
      return net.fetch(pathToFileURL(full).toString())
    })
  }

  /**
   * Bird photos are proxied through osl-bird:// so the sandboxed renderer never
   * makes a cross-origin request to the (parent-configured) BirdNET-Go host.
   * Only the fixed /media/image/ path is ever fetched.
   */
  function registerBirdImageProtocol(): void {
    protocol.handle('osl-bird', (request) => {
      const url = new URL(request.url)
      const base = url.searchParams.get('base') ?? ''
      const sci = url.searchParams.get('sci') ?? ''
      if (!/^https?:\/\//i.test(base) || sci === '') return new Response('bad request', { status: 400 })
      return net.fetch(`${base}/media/image/${encodeURIComponent(sci)}`)
    })
  }

  function listPhotos(): string[] {
    const folder = settings.getAll().screensaver.folder
    if (!folder) return []
    try {
      return readdirSync(folder)
        .filter((f) => PHOTO_EXTENSIONS.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => `osl-photo://photos/${encodeURIComponent(f)}`)
    } catch {
      return []
    }
  }

  async function pickFolder(): Promise<{ folder: string | null }> {
    const result = await dialog.showOpenDialog({
      title: 'Choose a photo folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return { folder: settings.getAll().screensaver.folder }
    const folder = result.filePaths[0]
    settings.set({ screensaver: { ...settings.getAll().screensaver, folder } })
    return { folder }
  }

  function setScreensaver(on: boolean): void {
    if (screensaverOn === on) return
    screensaverOn = on
    broadcast('push:kioskIdle', { state: on ? 'screensaver' : 'active' })
  }

  function setSleeping(on: boolean): void {
    if (sleeping === on) return
    sleeping = on
    broadcast('push:sleepState', { sleeping: on })
    if (reSleepTimer) clearTimeout(reSleepTimer)
    reSleepTimer = null
    setPanel(on)
    // while awake, keep the display alive; while asleep, let the OS power it down
    if (on) {
      if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      blockerId = null
    } else if (blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-display-sleep')
    }
  }

  /** Used by the settings "Preview" button. */
  function previewScreensaver(): void {
    broadcast('push:kioskIdle', { state: 'screensaver' })
  }

  function start(): void {
    registerPhotoProtocol()
    registerBirdImageProtocol()
    blockerId = powerSaveBlocker.start('prevent-display-sleep')

    idleTimer = setInterval(() => {
      const s = settings.getAll().screensaver
      setScreensaver(s.folder !== null && idleSeconds() >= s.idleMinutes * 60)
    }, IDLE_POLL_MS)

    sleepTimer = setInterval(() => {
      const s = settings.getAll().sleep
      if (!s.enabled) {
        setSleeping(false)
        return
      }
      const now = DateTime.now()
      setSleeping(isInSleepWindow(now.hour * 60 + now.minute, s.start, s.end))
    }, SLEEP_POLL_MS)
  }

  function stop(): void {
    if (idleTimer) clearInterval(idleTimer)
    if (sleepTimer) clearInterval(sleepTimer)
    if (reSleepTimer) clearTimeout(reSleepTimer)
  }

  function setLaunchOnStartup(enabled: boolean): void {
    if (!app.isPackaged) return // pointless (and confusing) for dev runs
    if (process.platform === 'linux') return setLinuxAutostart(enabled, process.execPath)
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
  }

  /** On Linux the autostart file is the source of truth; elsewhere the stored setting is. */
  function getLaunchOnStartup(stored: boolean): boolean {
    if (process.platform === 'linux' && app.isPackaged) return isLinuxAutostartEnabled()
    return stored
  }

  return { start, stop, listPhotos, pickFolder, previewScreensaver, setLaunchOnStartup, getLaunchOnStartup, reportActivity }
}

export type Kiosk = ReturnType<typeof createKiosk>
