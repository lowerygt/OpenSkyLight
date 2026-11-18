import { app, protocol, net } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

/**
 * Offline speech model plumbing for the voice-timer feature. The ~40MB Vosk
 * model is downloaded once on first enable (cached in userData, like an
 * auto-update payload — no account, no per-utterance network) and served to the
 * sandboxed renderer over the privileged osl-asset:// scheme so vosk-browser's
 * worker can fetch it under the production file:// origin.
 */

const MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz'
const MIN_VALID_BYTES = 5 * 1024 * 1024 // a real model is ~40MB; smaller = a failed/partial download

/** Must run before app 'ready'. */
export function registerVoiceScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'osl-asset',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

export function createVoiceService() {
  const dir = join(app.getPath('userData'), 'vosk')
  const modelPath = join(dir, 'model.tar.gz')
  let downloading: Promise<void> | null = null

  function isReady(): boolean {
    try {
      return existsSync(modelPath) && statSync(modelPath).size >= MIN_VALID_BYTES
    } catch {
      return false
    }
  }

  async function download(): Promise<void> {
    mkdirSync(dir, { recursive: true })
    const tmp = `${modelPath}.part`
    const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok || !res.body) throw new Error(`Model download failed (HTTP ${res.status})`)
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp)
      Readable.fromWeb(res.body as never)
        .pipe(out)
        .on('finish', resolve)
        .on('error', reject)
    })
    if (statSync(tmp).size < MIN_VALID_BYTES) throw new Error('Downloaded model looks incomplete')
    renameSync(tmp, modelPath) // atomic swap so a half file is never served
  }

  /** Idempotent + single-flight: concurrent callers share one download. */
  async function ensureModel(): Promise<{ ready: boolean }> {
    if (isReady()) return { ready: true }
    if (!downloading) downloading = download().finally(() => (downloading = null))
    await downloading
    return { ready: isReady() }
  }

  function getStatus(): { modelReady: boolean } {
    return { modelReady: isReady() }
  }

  /** osl-asset://vosk/model.tar.gz → the cached model file. */
  function registerProtocol(): void {
    protocol.handle('osl-asset', (request) => {
      const { pathname } = new URL(request.url)
      if (pathname !== '/vosk/model.tar.gz' && pathname !== '//vosk/model.tar.gz') {
        return new Response('not found', { status: 404 })
      }
      if (!isReady()) return new Response('model not ready', { status: 404 })
      return net.fetch(pathToFileURL(modelPath).toString())
    })
  }

  return { ensureModel, getStatus, registerProtocol, isReady, modelPath }
}

export type VoiceService = ReturnType<typeof createVoiceService>
