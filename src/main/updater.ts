import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { DateTime } from 'luxon'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Auto-update from GitHub Releases. Updates download in the background;
 * the kiosk installs them either when the user taps "Restart now" or
 * automatically during the quiet hours (03:30), so a wall display stays
 * current without anyone touching it.
 */
export function createUpdater(deps: { broadcast: (channel: string, payload: unknown) => void }) {
  let downloadedVersion: string | null = null
  let installTimer: NodeJS.Timeout | null = null

  function scheduleQuietInstall(): void {
    if (installTimer) clearTimeout(installTimer)
    const now = DateTime.now()
    let target = now.set({ hour: 3, minute: 30, second: 0, millisecond: 0 })
    if (target <= now) target = target.plus({ days: 1 })
    installTimer = setTimeout(() => quitAndInstall(), target.diff(now).toMillis())
  }

  function quitAndInstall(): void {
    if (!downloadedVersion) return
    autoUpdater.quitAndInstall(true, true) // silent install, relaunch after
  }

  function start(): void {
    if (!app.isPackaged) return // updater is meaningless (and errors) in dev
    // Linux .deb updates need root (dpkg via pkexec), which an unattended kiosk can't grant;
    // update by installing the new .deb instead
    if (process.platform === 'linux') return

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('update-downloaded', (info) => {
      downloadedVersion = info.version
      deps.broadcast('push:updateReady', { version: info.version })
      scheduleQuietInstall()
    })
    autoUpdater.on('error', (err) => {
      // offline kiosks hit this routinely; log and try again next interval
      console.error('[updater]', err.message)
    })

    const check = (): void => {
      autoUpdater.checkForUpdates().catch(() => undefined)
    }
    setTimeout(check, 30_000) // let the app settle first
    setInterval(check, CHECK_INTERVAL_MS)
  }

  return { start, quitAndInstall }
}

export type Updater = ReturnType<typeof createUpdater>
