import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { app, safeStorage } from 'electron'
import { WebSocketServer, WebSocket } from 'ws'
import ffmpegStatic from 'ffmpeg-static'
import { uuidv7 } from '@shared/uuid'
import type { CameraDto } from '@shared/types'
import type { SettingsService } from './settingsService'
import { AppError, invalid, notFound } from './errors'
import { buildFfmpegArgs, isValidRtspUrl } from './cameraArgs'

const KEY_CAMERAS = 'cameras.v1'
const MAX_CLIENT_BUFFER = 8 * 1024 * 1024 // drop clients that fall this far behind
/** A stream with no connected viewers dies after this grace period — covers
 * renderer reloads/crashes where effect cleanups (and camera:stop) never run. */
const NO_CLIENTS_GRACE_MS = 30_000
const URL_LOST_MSG = "This camera's saved address could not be read (keyring changed or profile moved). Remove the camera and add it again."

/**
 * RTSP camera streaming. ffmpeg pulls the camera feed and REMUXES it (H.264
 * copy, no transcode) into MPEG-TS on stdout; we relay those bytes to tile
 * clients over a token-gated WebSocket bound to 127.0.0.1. Camera URLs hold
 * credentials, so they are encrypted at rest and never leave the main process.
 *
 * Lifecycle protocol: camera:start returns a per-viewer SESSION id bound to a
 * specific stream generation; camera:stop presents that session. A stop from a
 * dead generation can therefore never kill a newer stream (the crash/retry
 * ping-pong class of bug). As a backstop, a stream with zero WebSocket clients
 * for 30s is killed regardless of session bookkeeping.
 */

export function resolveFfmpegPath(): string | null {
  const p = ffmpegStatic as unknown as string | null
  if (!p) return null
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p
}

function encryptUrl(plain: string): string {
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(plain)
    : Buffer.from(`plain:${plain}`, 'utf8')
  return buf.toString('base64')
}

function decryptUrl(b64: string): string {
  const buf = Buffer.from(b64, 'base64')
  const asString = buf.toString('utf8')
  if (asString.startsWith('plain:')) return asString.slice(6)
  return safeStorage.decryptString(buf)
}

interface StoredCamera {
  id: string
  name: string
  urlEnc: string
}

interface ActiveStream {
  cameraId: string
  proc: ChildProcess
  clients: Set<WebSocket>
  sessions: Set<string>
  stderrTail: string
  graceTimer: NodeJS.Timeout | null
}

export function createCameraService(settings: SettingsService) {
  const streams = new Map<string, ActiveStream>()
  const sessions = new Map<string, ActiveStream>()
  const token = randomBytes(16).toString('hex')
  let wss: WebSocketServer | null = null
  let wssPort: Promise<number> | null = null

  function loadCameras(): StoredCamera[] {
    try {
      const raw = settings.getRaw(KEY_CAMERAS)
      const parsed = raw ? (JSON.parse(raw) as StoredCamera[]) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function saveCameras(cameras: StoredCamera[]): void {
    settings.setRaw(KEY_CAMERAS, JSON.stringify(cameras))
  }

  /** Clears URLs that no longer decrypt so the UI can ask for re-entry instead of retrying forever. */
  function readableUrl(camera: StoredCamera): string | null {
    if (!camera.urlEnc) return null
    try {
      return decryptUrl(camera.urlEnc)
    } catch (err) {
      console.warn(`[camera] URL for "${camera.name}" could not be decrypted; clearing it:`, (err as Error).message)
      saveCameras(loadCameras().map((c) => (c.id === camera.id ? { ...c, urlEnc: '' } : c)))
      return null
    }
  }

  function list(): CameraDto[] {
    return loadCameras().map((c) => ({ id: c.id, name: c.name, needsUrl: readableUrl(c) === null }))
  }

  function add(name: string, url: string): CameraDto {
    if (!isValidRtspUrl(url)) throw invalid('Must be an rtsp:// or rtsps:// URL')
    const cameras = loadCameras()
    const camera: StoredCamera = { id: uuidv7(), name, urlEnc: encryptUrl(url.trim()) }
    cameras.push(camera)
    saveCameras(cameras)
    return { id: camera.id, name: camera.name }
  }

  function remove(cameraId: string): void {
    const cameras = loadCameras()
    if (!cameras.some((c) => c.id === cameraId)) throw notFound('Camera')
    const stream = streams.get(cameraId)
    if (stream) killStream(stream)
    saveCameras(cameras.filter((c) => c.id !== cameraId))
  }

  /** Lazy localhost-only WebSocket relay; resets itself on failure so one bad
   * bind doesn't brick cameras for the rest of the session. */
  function ensureServer(): Promise<number> {
    if (wssPort) return wssPort
    wssPort = new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      wss = server
      server.on('listening', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
      server.on('error', (err) => {
        console.error('[camera] ws server error:', err.message)
        // forget the broken server so the next camera:start can try again
        if (wss === server) {
          wss = null
          wssPort = null
        }
        server.close()
        reject(err)
      })
      server.on('close', () => {
        if (wss === server) {
          wss = null
          wssPort = null
        }
      })
      server.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '/', 'ws://127.0.0.1')
        const cameraId = url.pathname.replace(/^\//, '')
        const stream = streams.get(cameraId)
        if (url.searchParams.get('token') !== token || !stream) {
          ws.close(4001, 'unauthorized')
          return
        }
        stream.clients.add(ws)
        clearGrace(stream)
        ws.on('close', () => {
          stream.clients.delete(ws)
          if (stream.clients.size === 0) armGrace(stream)
        })
      })
    })
    return wssPort
  }

  function clearGrace(stream: ActiveStream): void {
    if (stream.graceTimer) {
      clearTimeout(stream.graceTimer)
      stream.graceTimer = null
    }
  }

  /** Kill the stream if nobody (re)connects within the grace window. */
  function armGrace(stream: ActiveStream): void {
    clearGrace(stream)
    stream.graceTimer = setTimeout(() => {
      if (streams.get(stream.cameraId) === stream && stream.clients.size === 0) {
        killStream(stream)
      }
    }, NO_CLIENTS_GRACE_MS)
  }

  function purgeSessions(stream: ActiveStream): void {
    for (const sessionId of stream.sessions) sessions.delete(sessionId)
    stream.sessions.clear()
  }

  function killStream(stream: ActiveStream): void {
    clearGrace(stream)
    if (streams.get(stream.cameraId) === stream) streams.delete(stream.cameraId)
    purgeSessions(stream)
    for (const client of stream.clients) client.close(4002, 'stream stopped')
    stream.clients.clear()
    try {
      stream.proc.kill()
    } catch {
      // already dead
    }
  }

  function spawnStream(cameraId: string, rtspUrl: string): ActiveStream {
    const ffmpeg = resolveFfmpegPath()
    if (!ffmpeg) throw new AppError('FFMPEG_MISSING', 'ffmpeg binary not found — reinstall the app')
    const proc = spawn(ffmpeg, buildFfmpegArgs(rtspUrl), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stream: ActiveStream = { cameraId, proc, clients: new Set(), sessions: new Set(), stderrTail: '', graceTimer: null }

    proc.stdout!.on('data', (chunk: Buffer) => {
      for (const client of stream.clients) {
        if (client.readyState !== WebSocket.OPEN) continue
        if (client.bufferedAmount > MAX_CLIENT_BUFFER) {
          client.close(4003, 'client too slow')
          continue
        }
        client.send(chunk)
      }
    })
    proc.stderr!.on('data', (chunk: Buffer) => {
      stream.stderrTail = (stream.stderrTail + chunk.toString()).slice(-2000)
    })
    const onGone = (reason: string): void => {
      if (streams.get(cameraId) === stream) {
        console.error(`[camera] ffmpeg ${reason} for ${cameraId}:`, stream.stderrTail.slice(-500))
      }
      killStream(stream) // idempotent; also purges this generation's sessions
    }
    proc.on('exit', (code) => onGone(`exited (${code})`))
    proc.on('error', (err) => onGone(`failed to start (${err.message})`))

    streams.set(cameraId, stream)
    // if no tile ever connects (renderer died mid-start), don't run forever
    armGrace(stream)
    return stream
  }

  /** Start (or join) a camera stream. Returns a per-viewer session id that
   * camera:stop must present. */
  async function start(cameraId: string): Promise<{ wsUrl: string; sessionId: string }> {
    const camera = loadCameras().find((c) => c.id === cameraId)
    if (!camera) throw notFound('Camera')
    const port = await ensureServer()
    let stream = streams.get(cameraId)
    if (!stream) {
      const url = readableUrl(camera)
      if (url === null) throw new AppError('CAMERA_URL_UNREADABLE', URL_LOST_MSG)
      stream = spawnStream(cameraId, url)
    }
    const sessionId = uuidv7()
    stream.sessions.add(sessionId)
    sessions.set(sessionId, stream)
    return { wsUrl: `ws://127.0.0.1:${port}/${cameraId}?token=${token}`, sessionId }
  }

  function stop(sessionId: string): void {
    const stream = sessions.get(sessionId)
    if (!stream) return // session's generation already died — never touch newer streams
    sessions.delete(sessionId)
    stream.sessions.delete(sessionId)
    if (stream.sessions.size === 0) killStream(stream)
  }

  /** Kill every ffmpeg on app quit. */
  function shutdown(): void {
    for (const stream of [...streams.values()]) killStream(stream)
    wss?.close()
  }

  return { list, add, remove, start, stop, shutdown }
}

export type CameraService = ReturnType<typeof createCameraService>
