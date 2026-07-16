import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, promises as fs } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DateTime } from 'luxon'
import type { IpcChannel } from '@shared/ipc/contract'
import { isChannelExposed, requiresDmzToken, type ApiSurface } from '@shared/ipc/exposure'
import { openDatabase } from '../main/db/client'
import { createSettingsService } from '../main/services/settingsService'
import { createPeopleService } from '../main/services/peopleService'
import { createCalendarService } from '../main/services/calendarService'
import { createEventService } from '../main/services/eventService'
import { createWeatherService } from '../main/services/weatherService'
import { createAuthService } from '../main/services/authService'
import { createChoresService } from '../main/services/choresService'
import { createRewardsService } from '../main/services/rewardsService'
import { createListsService } from '../main/services/listsService'
import { createMealsService } from '../main/services/mealsService'
import { createRssService } from '../main/services/rssService'
import { createBirdNetService } from '../main/services/birdnetService'
import { createIcsSync } from '../main/sync/icsSync'
import { AppError } from '../main/services/errors'
import { buildChannelTable, dispatch, type Services } from '../main/ipc/core'
import { createCompanionTokens } from '../main/companion/companionTokens'

const MAX_BODY_BYTES = 512 * 1024
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

function unsupported(feature: string): never {
  throw new AppError('UNSUPPORTED', `${feature} is not available in web mode`)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolveBody) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolveBody(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolveBody(null))
  })
}

async function serveStatic(staticRoot: string, res: ServerResponse, urlPath: string): Promise<void> {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(staticRoot, clean)
  if (!filePath.startsWith(staticRoot + sep) && filePath !== staticRoot) {
    res.writeHead(403).end()
    return
  }
  if (urlPath === '/' || urlPath === '') filePath = join(staticRoot, 'index.html')
  let data: Buffer
  try {
    data = await fs.readFile(filePath)
  } catch {
    if (extname(filePath) === '') {
      try {
        data = await fs.readFile(join(staticRoot, 'index.html'))
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
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:"
  } else if (clean.includes('assets')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  } else {
    headers['Cache-Control'] = 'no-cache'
  }
  res.writeHead(200, headers)
  res.end(data)
}

export interface WebHttpServerDeps {
  staticRoot: string
  version: string
  surface: ApiSurface
  rpcDispatch: (channel: IpcChannel, payload: unknown) => Promise<unknown>
  verifyToken?: (token: string) => boolean
}

export function createWebHttpServer(deps: WebHttpServerDeps) {
  return createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { app: 'openskylight-web', version: deps.version })
      return
    }
    const rpcMatch = url.match(/^\/api\/rpc\/([^/?]+)$/)
    if (rpcMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD', message: 'POST only' } })
        return
      }
      void (async () => {
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
        const channel = decodeURIComponent(rpcMatch[1]) as IpcChannel
        if (!isChannelExposed(channel, deps.surface)) {
          sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown channel' } })
          return
        }
        if (deps.surface === 'dmz' && requiresDmzToken(channel)) {
          const auth = req.headers.authorization ?? ''
          const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
          if (!deps.verifyToken?.(token)) {
            sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Not paired' } })
            return
          }
        }
        const result = await deps.rpcDispatch(channel, payload)
        sendJson(res, 200, result)
      })()
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
    if (deps.surface === 'dmz') {
      res.writeHead(404).end('Not found')
      return
    }
    void serveStatic(deps.staticRoot, res, url)
  })
}

export async function main(): Promise<void> {
  const dataDir = process.env.OSL_DATA_DIR ?? join(process.cwd(), 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = process.env.OSL_DB_PATH ?? join(dataDir, 'openskylight.db')
  const staticRoot = resolve(process.env.OSL_WEB_ROOT ?? join(process.cwd(), 'out/web'))
  const port = Number(process.env.PORT ?? '8420')
  const dmzPort = Number(process.env.OSL_DMZ_PORT ?? '0')

  const { db } = openDatabase(dbPath)
  const deviceTz = (): string => DateTime.local().zoneName ?? 'UTC'

  const settings = createSettingsService(db)
  const tokens = createCompanionTokens(settings)
  const chores = createChoresService(db, deviceTz)
  const icsSync = createIcsSync({ db, deviceTz })
  const broadcast = (_channel: string, _payload: unknown): void => {}
  const pairBaseUrl = process.env.OSL_PAIR_BASE_URL?.trim() || null
  const dmzBasePort = Number.isFinite(dmzPort) && dmzPort > 0 ? dmzPort : port

  const services: Services = {
    settings,
    people: createPeopleService(db),
    calendars: createCalendarService(db),
    events: createEventService(db),
    googleAuth: {
      isConfigured: () => false,
      setCredentials: () => unsupported('Google OAuth setup'),
      connect: async () => unsupported('Google OAuth setup'),
      listAccounts: () => [],
      getAuthedClient: () => unsupported('Google OAuth setup'),
      markAuthError: () => undefined,
      disconnect: () => unsupported('Google OAuth setup')
    },
    googleSync: {
      listRemoteCalendars: async () => [],
      setCalendarSelected: () => unsupported('Google calendar sync'),
      pullCalendar: async () => false,
      api: () => unsupported('Google calendar sync')
    },
    icsSync,
    syncManager: {
      start: () => undefined,
      stop: () => undefined,
      syncNow: () => undefined,
      getStatus: () => ({ state: 'idle', lastError: null, calendars: [] })
    },
    weather: createWeatherService(settings),
    auth: createAuthService(settings),
    chores,
    rewards: createRewardsService(db, chores),
    lists: createListsService(db),
    meals: createMealsService(db),
    kiosk: {
      start: () => undefined,
      stop: () => undefined,
      listPhotos: () => [],
      pickFolder: async () => unsupported('Screensaver folder picker'),
      previewScreensaver: () => undefined,
      setLaunchOnStartup: () => undefined
    },
    updater: {
      start: () => undefined,
      quitAndInstall: () => unsupported('Auto-update install')
    },
    rss: createRssService(),
    camera: {
      list: () => [],
      add: () => unsupported('RTSP camera tiles'),
      remove: () => unsupported('RTSP camera tiles'),
      start: async () => unsupported('RTSP camera tiles'),
      stop: () => undefined,
      shutdown: () => undefined
    },
    birdnet: createBirdNetService(),
    companion: {
      applySettings: () => undefined,
      getStatus: () => ({
        running: true,
        port: dmzBasePort,
        urls: [pairBaseUrl ?? `http://localhost:${dmzBasePort}/`],
        pairedCount: tokens.count(),
        lastError: null
      }),
      issueToken: () => {
        const token = tokens.issue()
        const base = pairBaseUrl ?? `http://localhost:${dmzBasePort}/`
        return { url: `${base.replace(/\/$/, '')}/#t=${token}` }
      },
      unpairAll: () => tokens.revokeAll(),
      stop: () => undefined,
      shutdown: () => undefined
    }
  }
  const table = buildChannelTable(services, {
    version: process.env.npm_package_version ?? 'dev',
    platform: process.platform,
    zone: deviceTz()
  })

  const server = createWebHttpServer({
    staticRoot,
    version: process.env.npm_package_version ?? 'dev',
    surface: 'lan',
    rpcDispatch: (channel, payload) => dispatch(services, table, channel, payload, { gate: 'pin', broadcast }),
    verifyToken: tokens.verify
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[web] OpenSkyLight serving on http://0.0.0.0:${port}`)
    console.log(`[web] Database: ${dbPath}`)
  })

  if (Number.isFinite(dmzPort) && dmzPort > 0) {
    const dmzServer = createWebHttpServer({
      staticRoot,
      version: process.env.npm_package_version ?? 'dev',
      surface: 'dmz',
      rpcDispatch: (channel, payload) => dispatch(services, table, channel, payload, { gate: 'pin', broadcast }),
      verifyToken: tokens.verify
    })
    dmzServer.listen(dmzPort, '0.0.0.0', () => {
      console.log(`[web] DMZ API serving on http://0.0.0.0:${dmzPort} (no static UI)`)
    })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
}
