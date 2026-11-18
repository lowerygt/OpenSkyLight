// E2E: lists (create, add item, check off) and meal planning (set dinner,
// see it on the week grid) through the real UI.
import { _electron as electron } from 'playwright-core'
import { waitForBoot } from './e2e-lib.mjs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const userData = mkdtempSync(join(tmpdir(), 'osl-lists-'))
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: ['out/main/index.js', '--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await waitForBoot(page)

  // Lists: create a grocery list, add an item, check it off
  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: 'New list' }).click()
  await page.getByPlaceholder('e.g. Groceries').fill('Groceries')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Nothing here yet', { timeout: 5000 })
  await page.getByPlaceholder('Add item…').fill('Milk')
  await page.getByLabel('Add item').click()
  await page.waitForSelector('text=Milk', { timeout: 5000 })
  await page.getByLabel('Check', { exact: true }).click()
  await page.waitForSelector('text=Clear 1 done', { timeout: 5000 })
  await page.screenshot({ path: 'shots/lists.png' })

  // Meals: set tonight's dinner from the week view
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await page.getByRole('button', { name: '+ Meals' }).first().click()
  await page.getByPlaceholder("What's for dinner?").fill('Tacos')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Tacos', { timeout: 5000 })
  await page.screenshot({ path: 'shots/meals.png' })

  console.log('LISTS+MEALS E2E PASS: list item checked, dinner visible on the week grid')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
