import { execFile } from 'node:child_process'

/**
 * Linux panel power via `xset dpms`. Best effort only: on Wayland, or without the
 * x11-xserver-utils package, xset fails or is missing and we silently fall back to
 * the black sleep overlay. Never throws.
 */
let warned = false

function xset(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile('xset', args, { timeout: 5_000 }, (err) => {
        if (err && !warned) {
          warned = true
          console.warn(`[kiosk] xset ${args.join(' ')} failed; using the sleep overlay only:`, err.message)
        }
        resolve(!err)
      })
    } catch {
      resolve(false)
    }
  })
}

export async function panelOff(): Promise<boolean> {
  return xset(['dpms', 'force', 'off'])
}

export async function panelOn(): Promise<boolean> {
  const on = await xset(['dpms', 'force', 'on'])
  const reset = await xset(['s', 'reset'])
  return on && reset
}
