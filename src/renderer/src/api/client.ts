import type { IpcChannel, IpcContract, IpcResult } from '@shared/ipc/contract'

export class IpcError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'IpcError'
  }
}

const httpBridge: Window['osl'] = {
  async invoke(channel, payload) {
    const res = await fetch(`/api/rpc/${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? '' : JSON.stringify(payload)
    })
    return (await res.json()) as IpcResult<unknown>
  },
  on() {
    return () => {}
  }
}

export function ensureBridge(): Window['osl'] {
  if (typeof window !== 'undefined') {
    if (!window.osl) window.osl = httpBridge
    return window.osl
  }
  return httpBridge
}

export async function ipcInvoke<K extends IpcChannel>(
  channel: K,
  req: IpcContract[K]['req']
): Promise<IpcContract[K]['res']> {
  const result = (await ensureBridge().invoke(channel, req)) as IpcResult<IpcContract[K]['res']>
  if (!result.ok) throw new IpcError(result.error.code, result.error.message)
  return result.data
}
