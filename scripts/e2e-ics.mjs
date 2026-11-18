// E2E: subscribe to a live ICS feed through the settings UI and verify the
// event shows up on the calendar.
import { _electron as electron } from 'playwright-core'
import { waitForBoot } from './e2e-lib.mjs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-ics-'))
mkdirSync('shots', { recursive: true })

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//OSL Test//EN',
  'BEGIN:VEVENT',
  'UID:smoke-feed-event@test',
  `DTSTAMP:${today}T000000Z`,
  `DTSTART;VALUE=DATE:${today}`,
  'SUMMARY:Library book sale',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/calendar' })
  res.end(FEED)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const feedUrl = `http://127.0.0.1:${server.address().port}/feed.ics`

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await waitForBoot(page)

  await page.getByLabel('Settings').click()
  await page.getByRole('button', { name: 'Calendars' }).click()
  await page.getByPlaceholder('https://… .ics feed URL').fill(feedUrl)
  await page.getByPlaceholder('Name', { exact: true }).fill('Library')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  // feed row appears in settings
  await page.waitForSelector('text=Library book sale', { timeout: 20000 }).catch(() => {})
  await page.getByLabel('Close').click()

  // event lands in the week grid after the triggered sync
  await page.waitForSelector('text=Library book sale', { timeout: 20000 })
  await page.screenshot({ path: 'shots/ics-synced.png' })
  console.log('ICS E2E PASS: feed event visible on the calendar')
} finally {
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
}
