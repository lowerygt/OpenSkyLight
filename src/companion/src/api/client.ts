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

/** Pull a pairing token out of the QR URL fragment (#t=…), then scrub it. */
export function adoptTokenFromUrl(): void {
  const tokenMatch = window.location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/)
  const apiMatch = window.location.hash.match(/[#&]api=([^&]+)/)
  if (tokenMatch) {
    setToken(tokenMatch[1])
    if (apiMatch) {
      try {
        const parsed = new URL(decodeURIComponent(apiMatch[1]))
        setApiBase(parsed.origin)
      } catch {
        // ignore malformed api hint and keep same-origin fallback
      }
    }
    history.replaceState(null, '', window.location.pathname)
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
