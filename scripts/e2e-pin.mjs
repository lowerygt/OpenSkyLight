// E2E: set a parental PIN through the UI, verify settings lock behind it,
// reject a wrong PIN, and accept the right one.
import { _electron as electron } from 'playwright-core'
import { waitForBoot } from './e2e-lib.mjs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-pin-'))

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await waitForBoot(page)

  const pad = () => page.locator('.animate-pop').last()
  const tap = async (key) => pad().getByRole('button', { name: key, exact: true }).click()
  const enterPin = async (digits) => {
    for (const d of digits) await tap(d)
    await tap('OK')
  }

  // 1. no PIN yet — settings open directly; set PIN 2468 (entered twice)
  await page.getByLabel('Settings').click()
  await page.getByRole('button', { name: 'General', exact: true }).click()
  await page.getByRole('button', { name: 'Set PIN' }).click()
  await enterPin('2468')
  await page.waitForSelector('text=Enter it once more', { timeout: 5000 })
  await enterPin('2468')
  await page.waitForSelector('text=Change PIN', { timeout: 5000 })
  await page.getByLabel('Close').click()

  // 2. gear now prompts for the PIN
  await page.getByLabel('Settings').click()
  await page.waitForSelector('text=Enter parent PIN', { timeout: 5000 })

  // 3. wrong PIN is rejected
  await enterPin('9999')
  await page.waitForSelector('text=Wrong PIN', { timeout: 5000 })

  // 4. correct PIN opens settings
  await enterPin('2468')
  await page.waitForSelector('text=Settings', { timeout: 5000 })
  await page.waitForSelector('text=Family', { timeout: 5000 })

  console.log('PIN E2E PASS: lock set, wrong PIN rejected, correct PIN unlocks')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
