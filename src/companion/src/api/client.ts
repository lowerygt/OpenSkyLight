import type { IpcChannel, IpcContract, IpcResult } from '@shared/ipc/contract'

const TOKEN_KEY = 'osl.companionToken'
const API_BASE_KEY = 'osl.companionApiBase'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(API_BASE_KEY)
}

function setApiBase(url: string): void {
  localStorage.setItem(API_BASE_KEY, url)
}

function getApiBase(): string | null {
  return localStorage.getItem(API_BASE_KEY)
}

function isStandaloneMode(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function readPairingParam(name: string): string | null {
  const query = new URLSearchParams(window.location.search)
  const fromQuery = query.get(name)
  if (fromQuery) return fromQuery
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return fragment.get(name)
}

function readTokenFromPath(): string | null {
  const match = window.location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)(?:\/|$)/)
  return match ? match[1] : null
}

/** Pull pairing token/API hint from URL params, preserving browser URL for iOS install handoff. */
export function adoptTokenFromUrl(): void {
  const token = readPairingParam('t') ?? readTokenFromPath()
  const api = readPairingParam('api')
  if (token) {
    setToken(token)
    if (api) {
      try {
        const parsed = new URL(decodeURIComponent(api))
        setApiBase(parsed.origin)
      } catch {
        // ignore malformed api hint and keep same-origin fallback
      }
    }
    // In Safari, keeping params lets Add-to-Home-Screen carry the pairing state.
    // The installed app then scrubs them on first standalone launch.
    if (isStandaloneMode()) history.replaceState(null, '', window.location.pathname)
  }
}

let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

export class RpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Same shape as the kiosk renderer's ipcInvoke, over HTTP. */
export async function rpc<K extends IpcChannel>(
  channel: K,
  req: IpcContract[K]['req']
): Promise<IpcContract[K]['res']> {
  const apiBase = getApiBase() ?? window.location.origin
  const url = new URL(`/api/rpc/${channel}`, apiBase)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken() ?? ''}`,
      'Content-Type': 'application/json'
    },
    body: req === undefined ? '' : JSON.stringify(req)
  })
  if (res.status === 401) {
    clearToken()
    onUnauthorized()
    throw new RpcError('UNAUTHORIZED', 'Not paired')
  }
  const json = (await res.json()) as IpcResult<IpcContract[K]['res']>
  if (!json.ok) throw new RpcError(json.error.code, json.error.message)
  return json.data
}
