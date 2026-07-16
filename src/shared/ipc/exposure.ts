import type { IpcChannel } from './contract'
import { COMPANION_CHANNELS } from './companionChannels'

export type ApiSurface = 'lan' | 'dmz'

/**
 * Channels permitted on the DMZ-facing API listener.
 * Keep this list small and explicit; everything else stays LAN-only.
 */
export const DMZ_CHANNELS: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  ...COMPANION_CHANNELS,
  'companion:getStatus',
  'companion:issueToken',
  'companion:unpairAll',
  'sync:getStatus',
  'sync:now'
])

export function isChannelExposed(channel: IpcChannel, surface: ApiSurface): boolean {
  if (surface === 'lan') return true
  return DMZ_CHANNELS.has(channel)
}
