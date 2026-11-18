// End-to-end smoke test: launch the built app with an isolated data dir,
// create an event through the real UI, and verify it appears in the week grid.
import { _electron as electron } from 'playwright-core'
import { waitForBoot } from './e2e-lib.mjs'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-smoke-'))
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await waitForBoot(page)
  // the app boots to Home; event creation lives on the calendar views
  await page.getByRole('button', { name: 'Week', exact: true }).click()

  // Open the editor via the FAB and create an event
  await page.getByLabel('Add event').click()
  await page.getByPlaceholder("What's happening?").fill('Soccer practice')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // The card should appear in the week grid
  await page.waitForSelector('text=Soccer practice', { timeout: 5000 })
  await page.screenshot({ path: 'shots/smoke-created.png' })

  // Reopen it and verify the editor loads the event
  await page.getByText('Soccer practice').first().click()
  await page.waitForSelector('text=Edit event', { timeout: 5000 })

  console.log('SMOKE PASS: event created and visible in week view')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
