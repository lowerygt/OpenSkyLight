// E2E: set a weather location via city search (live Open-Meteo APIs) and
// verify the forecast appears in the header.
import { _electron as electron } from 'playwright-core'
import { waitForBoot } from './e2e-lib.mjs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-weather-'))
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await waitForBoot(page)

  await page.getByLabel('Settings').click()
  await page.getByRole('button', { name: 'General' }).click()
  await page.getByPlaceholder('Search city…').fill('Chicago')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByRole('button', { name: /Chicago, Illinois/ }).click()
  await page.waitForSelector('text=Chicago, Illinois', { timeout: 10000 })
  await page.getByLabel('Close').click()

  // header weather appears once the forecast is fetched
  await page.waitForSelector('[aria-label="Weather forecast"]', { timeout: 20000 })
  await page.getByLabel('Weather forecast').click()
  await page.waitForSelector('text=Today', { timeout: 10000 })
  await page.screenshot({ path: 'shots/weather.png' })
  console.log('WEATHER E2E PASS: forecast fetched and shown in header')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
