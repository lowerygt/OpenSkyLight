// E2E: screensaver (photo folder -> osl-photo:// protocol -> overlay renders a
// real decoded image) and sleep mode (window covering now -> black overlay,
// tap to wake).
import { _electron as electron } from 'playwright-core'
import { waitForBoot } from './e2e-lib.mjs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-kiosk-'))
const photoDir = mkdtempSync(join(tmpdir(), 'osl-photos-'))
mkdirSync('shots', { recursive: true })

// two tiny valid PNGs
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
writeFileSync(join(photoDir, 'one.png'), PNG)
writeFileSync(join(photoDir, 'two.png'), PNG)

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await waitForBoot(page)

  // --- screensaver ---
  await page.evaluate(
    (folder) => window.osl.invoke('settings:set', { patch: { screensaver: { folder, idleMinutes: 10 } } }),
    photoDir
  )
  const photos = await page.evaluate(() => window.osl.invoke('screensaver:listPhotos', undefined))
  if (!photos.ok || photos.data.length !== 2) throw new Error(`expected 2 photos, got ${JSON.stringify(photos)}`)

  await page.evaluate(() => window.osl.invoke('kiosk:previewScreensaver', undefined))
  await page.waitForSelector('img[src^="osl-photo://"]', { timeout: 5000 })
  const loaded = await page.evaluate(() => {
    const img = document.querySelector('img[src^="osl-photo://"]')
    return new Promise((resolveP) => {
      if (img.complete) resolveP(img.naturalWidth > 0)
      else {
        img.onload = () => resolveP(img.naturalWidth > 0)
        img.onerror = () => resolveP(false)
      }
    })
  })
  if (!loaded) throw new Error('screensaver photo failed to decode through osl-photo://')
  await page.screenshot({ path: 'shots/screensaver.png' })

  // tap dismisses
  await page.mouse.click(640, 400)
  await page.waitForSelector('img[src^="osl-photo://"]', { state: 'detached', timeout: 5000 })

  // --- sleep mode ---
  const pad = (n) => String(n).padStart(2, '0')
  const nowD = new Date()
  const start = `${pad((nowD.getHours() + 23) % 24)}:00`
  const end = `${pad((nowD.getHours() + 2) % 24)}:00`
  await page.evaluate(
    ({ start, end }) => window.osl.invoke('settings:set', { patch: { sleep: { enabled: true, start, end } } }),
    { start, end }
  )
  await page.waitForSelector('.z-\\[90\\]', { timeout: 15000 }) // poller runs every 5s
  // tap to wake
  await page.mouse.click(640, 400)
  await page.waitForSelector('.z-\\[90\\]', { state: 'detached', timeout: 5000 })

  console.log('KIOSK E2E PASS: photos served + screensaver shown + sleep window + tap-to-wake')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(photoDir, { recursive: true, force: true })
}
