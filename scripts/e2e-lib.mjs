// Shared e2e harness: isolated userData, a REAL boot signal, packaged-binary
// lookup. New e2e scripts should use launchApp(); older ones at least use
// waitForBoot() instead of waiting on text that is always on screen.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

/** A fresh temp userData dir so a run never touches real data. */
export function newUserData(prefix = 'osl-e2e-') {
  mkdirSync('shots', { recursive: true })
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanupUserData(dir) {
  rmSync(dir, { recursive: true, force: true })
}

export function packagedExecutable() {
  return resolve(
    process.platform === 'linux' ? 'dist/linux-unpacked/openskylight' : 'dist/win-unpacked/OpenSkyLight.exe'
  )
}

/**
 * App.tsx sets data-app-ready once settings have loaded and the boot view is
 * applied — unlike header text, this proves the renderer actually came up.
 */
export async function waitForBoot(page, timeout = 20000) {
  await page.waitForSelector('[data-app-ready="true"]', { timeout })
}

/**
 * Launch the built app (or the packaged one) against `userData` and wait for
 * boot. Reuse the same userData across calls to test persistence on relaunch.
 */
export async function launchApp({ userData, packaged = false, env = {}, args = [] } = {}) {
  const app = await electron.launch({
    executablePath: packaged ? packagedExecutable() : require('electron'),
    args: packaged ? ['--windowed', ...args] : ['out/main/index.js', '--windowed', ...args],
    env: { ...process.env, OSL_USER_DATA: userData, ...env }
  })
  const page = await app.firstWindow()
  await waitForBoot(page)
  return { app, page }
}
