// E2E: full chores + rewards loop through the real UI —
// add a child, create a chore and a reward, check the chore off on the board,
// redeem the reward, and grant it as a parent.
import { _electron as electron } from 'playwright-core'
import { waitForBoot } from './e2e-lib.mjs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-chores-'))
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await waitForBoot(page)

  // 1. add a child
  await page.getByLabel('Settings').click()
  await page.getByRole('button', { name: 'Add family member', exact: true }).click()
  await page.getByPlaceholder('Name').fill('Emma')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const sheet = () => page.locator('.animate-sheet-up')

  // 2. create a chore worth 2 stars
  await sheet().getByRole('button', { name: 'Chores', exact: true }).click()
  await page.getByRole('button', { name: 'Add chore' }).click()
  await page.getByPlaceholder('e.g. Make your bed').fill('Make bed')
  await page.getByRole('button', { name: '+', exact: true }).click() // stars 1 -> 2
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // 3. create a reward costing 2 stars
  await page.getByRole('button', { name: 'Add reward' }).click()
  await page.getByPlaceholder('e.g. Movie night pick').fill('Ice cream')
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: '−', exact: true }).click() // 10 -> 2
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByLabel('Close').click()

  // 4. chores board: check the chore off
  await page.getByRole('button', { name: 'Chores', exact: true }).click()
  await page.waitForSelector('text=Make bed', { timeout: 5000 })
  await page.getByRole('button', { name: /Make bed/ }).click()
  await page.waitForSelector('text=1/1 done', { timeout: 5000 })

  // 5. redeem the reward
  await page.getByRole('button', { name: '★ Rewards' }).click()
  await page.waitForSelector('text=★ 2', { timeout: 5000 })
  await page.getByRole('button', { name: 'Redeem', exact: true }).click()
  await page.waitForSelector('text=ask a parent', { timeout: 5000 })
  await page.screenshot({ path: 'shots/chores.png' })
  await page.keyboard.press('Escape').catch(() => {})
  await page.mouse.click(40, 300) // dismiss dialog via backdrop

  // 6. grant it in settings
  await page.getByLabel('Settings').click()
  await sheet().getByRole('button', { name: 'Chores', exact: true }).click()
  await page.waitForSelector('text=Waiting for approval', { timeout: 5000 })
  await page.getByRole('button', { name: 'Grant', exact: true }).click()
  await page.waitForSelector('text=Waiting for approval', { state: 'detached', timeout: 5000 })

  console.log('CHORES E2E PASS: chore checked, stars awarded, reward redeemed and granted')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
