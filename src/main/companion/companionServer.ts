import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import type { IpcChannel, IpcResult } from '@shared/ipc/contract'
import { COMPANION_CHANNELS } from '@shared/ipc/companionChannels'
import type { SettingsService } from '../services/settingsService'
import type { CompanionTokens } from './companionTokens'
import { pickLanAddresses } from './lanAddress'

const MAX_BODY_BYTES = 64 * 1024
const AUTH_FAIL_LIMIT = 30 // failures per IP per minute → 429
const AUTH_FAIL_WINDOW_MS = 60_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

export interface CompanionServerDeps {
  settings: Pick<SettingsService, 'getAll'>
  tokens: CompanionTokens
  /** The shared IPC pipeline with gate:'none' — the bearer token is the credential. */
  dispatch: (channel: IpcChannel, payload: unknown) => Promise<IpcResult<unknown>>
  version: string
  /** Directory holding the built companion web app (out/companion). */
  staticRoot: string
}

/**
 * LAN-facing HTTP server for the companion web app: serves the static mobile
 * UI and exposes an allowlisted slice of the IPC contract as POST /api/rpc/*.
 * Auth is a bearer token minted from the (PIN-gated) kiosk settings QR.
 */
export function createCompanionServer(deps: CompanionServerDeps) {
  let server: Server | null = null
  let boundPort: number | null = null
  let lastError: string | null = null
  const authFails = new Map<string, { count: number; windowStart: number }>()

  function rateLimited(ip: string): boolean {
    const now = Date.now()
    const entry = authFails.get(ip)
    if (!entry || now - entry.windowStart > AUTH_FAIL_WINDOW_MS) return false
    return entry.count >= AUTH_FAIL_LIMIT
  }

  function recordAuthFail(ip: string): void {
    const now = Date.now()
    const entry = authFails.get(ip)
    if (!entry || now - entry.windowStart > AUTH_FAIL_WINDOW_MS) {
      authFails.set(ip, { count: 1, windowStart: now })
    } else {
      entry.count += 1
    }
    // keep the map from growing unboundedly on a hostile network
    if (authFails.size > 1000) authFails.clear()
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(payload)
  }

  function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          resolve(null)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(null))
    })
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse, channelRaw: string): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (rateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts — wait a minute' } })
      return
    }
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!deps.tokens.verify(token)) {
      recordAuthFail(ip)
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Not paired — scan the QR code on the kiosk' } })
      return
    }
    const channel = decodeURIComponent(channelRaw) as IpcChannel
    if (!COMPANION_CHANNELS.has(channel)) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown channel' } })
      return
    }
    const body = await readBody(req)
    if (body === null) {
      sendJson(res, 413, { ok: false, error: { code: 'TOO_LARGE', message: 'Request too large' } })
      return
    }
    let payload: unknown
    try {
      payload = body.trim() === '' ? undefined : JSON.parse(body)
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'INVALID', message: 'Body must be JSON' } })
      return
    }
    const result = await deps.dispatch(channel, payload)
    sendJson(res, 200, result)
  }

  async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    // strip query, normalize, and refuse anything that escapes the root
    const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(deps.staticRoot, clean)
    if (!filePath.startsWith(deps.staticRoot + sep) && filePath !== deps.staticRoot) {
      res.writeHead(403).end()
      return
    }
    if (urlPath === '/' || urlPath === '') filePath = join(deps.staticRoot, 'index.html')
    let data: Buffer
    try {
      data = await fs.readFile(filePath)
    } catch {
      // SPA fallback: unknown non-asset paths get the shell
      if (extname(filePath) === '') {
        try {
          data = await fs.readFile(join(deps.staticRoot, 'index.html'))
          filePath = 'index.html'
        } catch {
          res.writeHead(404).end('Not found')
          return
        }
      } else {
        res.writeHead(404).end('Not found')
        return
      }
    }
    const ext = extname(filePath) || '.html'
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-store'
      headers['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'"
    } else if (clean.includes('assets')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable' // vite hashes asset names
    } else {
      headers['Cache-Control'] = 'no-cache'
    }
    res.writeHead(200, headers)
    res.end(data)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/'
    if (url === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { app: 'openskylight', version: deps.version })
      return
    }
    const rpcMatch = url.match(/^\/api\/rpc\/([^/?]+)$/)
    if (rpcMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } })
        return
      }
      void handleRpc(req, res, rpcMatch[1])
      return
    }
    if (url.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } })
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    void serveStatic(res, url)
  }

  function start(port: number): void {
    if (server) return
    lastError = null
    const srv = createServer(onRequest)
    srv.on('error', (err: NodeJS.ErrnoException) => {
      lastError =
        err.code === 'EADDRINUSE' ? `Port ${port} is already in use — pick another port` : (err.message ?? 'Server error')
      console.error('[companion] server error:', err)
      srv.close()
      if (server === srv) {
        server = null
        boundPort = null
      }
    })
    srv.listen(port, '0.0.0.0', () => {
      const addr = srv.address()
      boundPort = typeof addr === 'object' && addr ? addr.port : port
      console.log(`[companion] serving on 0.0.0.0:${boundPort}`)
    })
    server = srv
  }

  function stop(): void {
    server?.close()
    server = null
    boundPort = null
  }

  /** Reconcile the server with settings — called at boot and on every settings:set. */
  function applySettings(): void {
    const { enabled, port } = deps.settings.getAll().companion
    if (!enabled) {
      stop()
      return
    }
    if (server && boundPort === port) return
    stop()
    start(port)
  }

  function getStatus(): { running: boolean; port: number; urls: string[]; pairedCount: number; lastError: string | null } {
    const { port } = deps.settings.getAll().companion
    const running = server !== null && boundPort !== null
    return {
      running,
      port,
      urls: running ? pickLanAddresses().map((ip) => `http://${ip}:${boundPort}/`) : [],
      pairedCount: deps.tokens.count(),
      lastError
    }
  }

  /** Mint a pairing URL with path/query/fragment token handoff for iOS reliability. */
  function issueToken(): { url: string } {
    const { port } = deps.settings.getAll().companion
    const token = deps.tokens.issue()
    const [best] = pickLanAddresses()
    const base = `http://${best ?? 'localhost'}:${boundPort ?? port}/`
    const params = `t=${token}&api=${encodeURIComponent(base)}`
    return { url: `${base}p/${token}?${params}#${params}` }
  }

  function unpairAll(): void {
    deps.tokens.revokeAll()
  }

  return { applySettings, getStatus, issueToken, unpairAll, stop, shutdown: stop }
}

export type CompanionServer = ReturnType<typeof createCompanionServer>
