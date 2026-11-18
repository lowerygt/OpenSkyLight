// Boots the PACKAGED app (dist/win-unpacked, or dist/linux-unpacked on Linux) to verify asar paths and the
// rebuilt native module work outside the dev harness.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'osl-packaged-'))
mkdirSync('shots', { recursive: true })

const app = await electron.launch({
  executablePath: resolve(
    process.platform === 'linux'
      ? 'dist/linux-unpacked/openskylight'
      : 'dist/win-unpacked/OpenSkyLight.exe'
  ),
  args: ['--windowed'],
  env: { ...process.env, OSL_USER_DATA: userData }
})

try {
  const page = await app.firstWindow()
  await page.waitForSelector('[data-tile-type="todayEvents"]', { timeout: 20000 }) // home is the boot view
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  // prove the database works in the packaged build
  await page.getByLabel('Add event').click()
  await page.getByPlaceholder("What's happening?").fill('Packaged smoke')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Packaged smoke', { timeout: 5000 })
  await page.screenshot({ path: 'shots/packaged.png' })

  // companion: the static shell must serve from INSIDE app.asar
  const token = await page.evaluate(async () => {
    await window.osl.invoke('settings:set', { patch: { companion: { enabled: true, port: 8425 } } })
    await new Promise((r) => setTimeout(r, 500))
    const issued = await window.osl.invoke('companion:issueToken', undefined)
    return issued.data.url.split('#t=')[1]
  })
  const shell = await fetch('http://127.0.0.1:8425/')
  if (shell.status !== 200 || !(await shell.text()).includes('OpenSkyLight'))
    throw new Error(`companion shell not served from asar: ${shell.status}`)
  const rpcRes = await fetch('http://127.0.0.1:8425/api/rpc/lists:getAll', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (rpcRes.status !== 200) throw new Error(`companion rpc failed in packaged build: ${rpcRes.status}`)

  console.log('PACKAGED E2E PASS: installed build boots, persists events, serves companion from asar')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
}
