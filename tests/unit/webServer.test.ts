import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createWebHttpServer } from '../../src/web/server'
import type { IpcChannel } from '../../src/shared/ipc/contract'

describe('web server', () => {
  let server: Server | null = null
  let staticRoot: string | null = null

  afterEach(() => {
    server?.close()
    server = null
    if (staticRoot) rmSync(staticRoot, { recursive: true, force: true })
    staticRoot = null
  })

  async function boot(
    dispatchImpl?: (channel: IpcChannel, payload: unknown) => Promise<unknown>
  ): Promise<{ base: string; seen: { channel: IpcChannel; payload: unknown }[] }> {
    staticRoot = mkdtempSync(join(tmpdir(), 'osl-web-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>web</title>')
    writeFileSync(join(staticRoot, 'assets', 'app-abc123.js'), 'console.log(1)')
    writeFileSync(join(staticRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')

    const seen: { channel: IpcChannel; payload: unknown }[] = []
    server = createWebHttpServer({
      staticRoot,
      version: '0.0.0-test',
      rpcDispatch: async (channel, payload) => {
        seen.push({ channel, payload })
        if (dispatchImpl) return dispatchImpl(channel, payload)
        return { ok: true, data: 'ok' }
      }
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { base: `http://127.0.0.1:${port}`, seen }
  }

  it('serves health, static shell, spa fallback, assets, and favicon', async () => {
    const { base } = await boot()
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ app: 'openskylight-web', version: '0.0.0-test' })

    const root = await fetch(`${base}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-security-policy')).toContain("default-src 'self'")

    const spa = await fetch(`${base}/agenda`)
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('<title>web</title>')

    const asset = await fetch(`${base}/assets/app-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const favicon = await fetch(`${base}/favicon.svg`)
    expect(favicon.status).toBe(200)
    expect(favicon.headers.get('content-type')).toContain('image/svg+xml')
  })

  it('dispatches rpc payloads and validates method/body/errors', async () => {
    const { base, seen } = await boot(async (channel) => {
      if (channel === 'settings:set') return { ok: false, error: { code: 'LOCKED', message: 'locked' } }
      return { ok: true, data: null }
    })

    const badMethod = await fetch(`${base}/api/rpc/lists:getAll`, { method: 'GET' })
    expect(badMethod.status).toBe(405)

    const badJson = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad'
    })
    expect(badJson.status).toBe(400)

    const ok = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 })
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, data: null })
    expect(seen.at(-1)).toEqual({ channel: 'lists:getAll', payload: { a: 1 } })

    const wrappedErr = await fetch(`${base}/api/rpc/settings:set`, { method: 'POST', body: '{}' })
    expect(wrappedErr.status).toBe(200)
    expect(await wrappedErr.json()).toEqual({ ok: false, error: { code: 'LOCKED', message: 'locked' } })
  })

  it('returns 404 for unknown api routes and blocks traversal', async () => {
    const { base } = await boot()
    const unknownApi = await fetch(`${base}/api/nope`)
    expect(unknownApi.status).toBe(404)

    const sneaky = await fetch(`${base}/..%2f..%2fpackage.json`)
    expect([403, 404]).toContain(sneaky.status)
  })
})
