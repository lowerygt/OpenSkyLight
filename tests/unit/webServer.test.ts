import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { createWebHttpServer } from '../../src/web/server'
import type { IpcChannel } from '../../src/shared/ipc/contract'
import type { ApiSurface } from '../../src/shared/ipc/exposure'

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
    dispatchImpl?: (channel: IpcChannel, payload: unknown) => Promise<unknown>,
    surface: ApiSurface = 'lan'
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
      surface,
      verifyToken: (token) => token === 'paired-device-token',
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

  it('dmz surface blocks static UI and non-allowlisted channels', async () => {
    const { base } = await boot(undefined, 'dmz')

    const root = await fetch(`${base}/`)
    expect(root.status).toBe(404)

    const lanOnly = await fetch(`${base}/api/rpc/settings:getAll`, { method: 'POST' })
    expect(lanOnly.status).toBe(404)

    const noAuth = await fetch(`${base}/api/rpc/lists:getAll`, { method: 'POST' })
    expect(noAuth.status).toBe(401)

    const badAuth = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' }
    })
    expect(badAuth.status).toBe(401)

    const allowed = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Authorization: 'Bearer paired-device-token' }
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ ok: true, data: 'ok' })

    // pairing bootstrap channel is intentionally unauthenticated
    const issue = await fetch(`${base}/api/rpc/companion:issueToken`, { method: 'POST' })
    expect(issue.status).toBe(200)
  })

  it('dmz enforces origin allowlist and per-ip rate limits', async () => {
    const events: string[] = []
    const { base } = await boot(async () => ({ ok: true, data: 'ok' }), 'dmz')
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = createWebHttpServer({
      staticRoot: staticRoot!,
      version: '0.0.0-test',
      surface: 'dmz',
      verifyToken: (token) => token === 'paired-device-token',
      rpcDispatch: async () => ({ ok: true, data: 'ok' }),
      dmz: {
        allowedOrigins: ['https://phone.example.com'],
        rateLimitMax: 2,
        rateLimitWindowMs: 60_000,
        onSecurityEvent: (e) => events.push(e.kind)
      }
    })
    await new Promise<void>((resolve) => server!.listen(Number(new URL(base).port), '127.0.0.1', resolve))

    const badOrigin = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', Authorization: 'Bearer paired-device-token' }
    })
    expect(badOrigin.status).toBe(403)

    const preflight = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://phone.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type'
      }
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://phone.example.com')

    const one = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Origin: 'https://phone.example.com', Authorization: 'Bearer paired-device-token' }
    })
    expect(one.status).toBe(200)
    expect(one.headers.get('x-frame-options')).toBe('DENY')

    const two = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Origin: 'https://phone.example.com', Authorization: 'Bearer paired-device-token' }
    })
    expect(two.status).toBe(200)

    const three = await fetch(`${base}/api/rpc/lists:getAll`, {
      method: 'POST',
      headers: { Origin: 'https://phone.example.com', Authorization: 'Bearer paired-device-token' }
    })
    expect(three.status).toBe(429)
    expect(events).toContain('invalid_origin')
    expect(events).toContain('rate_limited')
  })
})
