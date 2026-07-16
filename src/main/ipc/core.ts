import type { ZodType } from 'zod'
import { ZodError } from 'zod'
import type { IpcChannel, IpcContract, IpcResult } from '@shared/ipc/contract'
import * as s from '@shared/ipc/schemas'
import { AppError } from '../services/errors'
import type { SettingsService } from '../services/settingsService'
import type { PeopleService } from '../services/peopleService'
import type { CalendarService } from '../services/calendarService'
import type { EventService } from '../services/eventService'
import type { GoogleAuth } from '../sync/googleAuth'
import type { GoogleSync } from '../sync/googleSync'
import type { IcsSync } from '../sync/icsSync'
import type { SyncManager } from '../sync/scheduler'
import type { WeatherService } from '../services/weatherService'
import type { AuthService } from '../services/authService'
import type { ChoresService } from '../services/choresService'
import type { RewardsService } from '../services/rewardsService'
import type { ListsService } from '../services/listsService'
import type { MealsService } from '../services/mealsService'
import type { Kiosk } from '../kiosk/kiosk'
import type { Updater } from '../updater'
import type { RssService } from '../services/rssService'
import type { CameraService } from '../services/cameraService'
import type { BirdNetService } from '../services/birdnetService'
import type { CompanionServer } from '../companion/companionServer'

export interface Services {
  settings: SettingsService
  people: PeopleService
  calendars: CalendarService
  events: EventService
  googleAuth: GoogleAuth
  googleSync: GoogleSync
  icsSync: IcsSync
  syncManager: SyncManager
  weather: WeatherService
  auth: AuthService
  chores: ChoresService
  rewards: RewardsService
  lists: ListsService
  meals: MealsService
  kiosk: Kiosk
  updater: Updater
  rss: RssService
  camera: CameraService
  birdnet: BirdNetService
  companion: CompanionServer
}

/**
 * Channels behind the parental PIN gate. Enforced here in the main process —
 * the renderer's lock screen is UX, this is the security boundary.
 */
const PARENT_GATED: Set<IpcChannel> = new Set([
  'settings:set',
  'auth:setPin',
  'google:setCredentials',
  'google:connect',
  'google:disconnect',
  'google:setCalendarSelected',
  'ics:add',
  'calendars:create',
  'calendars:update',
  'calendars:delete',
  'people:create',
  'people:update',
  'people:delete',
  'chores:create',
  'chores:update',
  'chores:delete',
  'rewards:create',
  'rewards:update',
  'rewards:delete',
  'rewards:grant',
  'screensaver:pickFolder',
  'camera:add',
  'camera:remove',
  'companion:issueToken',
  'companion:unpairAll'
])

/** Channels that mutate data, mapped to the domain the renderer should refetch. */
type MutationDomain = 'events' | 'people' | 'calendars' | 'settings' | 'lists' | 'meals' | 'chores'
const MUTATION_DOMAINS: Partial<Record<IpcChannel, MutationDomain>> = {
  'settings:set': 'settings',
  'people:create': 'people',
  'people:update': 'people',
  'people:delete': 'people',
  'calendars:create': 'calendars',
  'calendars:update': 'calendars',
  'calendars:delete': 'calendars',
  'events:create': 'events',
  'events:update': 'events',
  'events:delete': 'events',
  'google:connect': 'calendars',
  'google:disconnect': 'calendars',
  'google:setCalendarSelected': 'calendars',
  'ics:add': 'calendars',
  'lists:create': 'lists',
  'lists:update': 'lists',
  'lists:delete': 'lists',
  'listItems:add': 'lists',
  'listItems:toggle': 'lists',
  'listItems:delete': 'lists',
  'listItems:clearChecked': 'lists',
  'meals:set': 'meals',
  'chores:create': 'chores',
  'chores:update': 'chores',
  'chores:delete': 'chores',
  'chores:complete': 'chores',
  'chores:uncomplete': 'chores'
}

interface ChannelEntry {
  schema: ZodType | null
  fn: (req: unknown) => unknown
}
export type ChannelTable = Map<IpcChannel, ChannelEntry>

/**
 * Run one request through the full pipeline: gate → validate → handler →
 * change broadcast → envelope. Shared by ipcMain (gate: 'pin') and HTTP RPC.
 */
export async function dispatch<K extends IpcChannel>(
  services: Services,
  table: ChannelTable,
  channel: K,
  payload: unknown,
  opts: { gate: 'pin' | 'none'; broadcast: (channel: string, payload: unknown) => void }
): Promise<IpcResult<IpcContract[K]['res']>> {
  const entry = table.get(channel)
  if (!entry) return { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown channel' } }
  try {
    if (opts.gate === 'pin' && PARENT_GATED.has(channel)) services.auth.assertUnlocked()
    const req = entry.schema ? entry.schema.parse(payload) : payload
    const data = (await entry.fn(req)) as IpcContract[K]['res']
    const domain = MUTATION_DOMAINS[channel]
    if (domain) opts.broadcast('push:dataChanged', { domain })
    return { ok: true, data }
  } catch (err) {
    if (err instanceof AppError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    if (err instanceof ZodError) {
      return { ok: false, error: { code: 'INVALID', message: err.issues[0]?.message ?? 'Invalid input' } }
    }
    console.error(`[ipc] ${channel} failed:`, err)
    return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } }
  }
}

/** The single channel → {schema, handler} map consumed by ipcMain and HTTP APIs. */
export function buildChannelTable(
  services: Services,
  runtimeInfo: { version: string; platform: string; zone: string }
): ChannelTable {
  const table: ChannelTable = new Map()
  function handle<K extends IpcChannel>(
    channel: K,
    schema: ZodType | null,
    fn: (req: IpcContract[K]['req']) => IpcContract[K]['res'] | Promise<IpcContract[K]['res']>
  ): void {
    table.set(channel, { schema, fn: fn as (req: unknown) => unknown })
  }

  handle('app:getInfo', null, () => runtimeInfo)
  handle('app:installUpdate', null, () => services.updater.quitAndInstall())

  handle('settings:getAll', null, () => services.settings.getAll())
  handle('settings:set', s.settingsPatchSchema, (req) => {
    const result = services.settings.set(req.patch)
    if (req.patch.launchOnStartup !== undefined) services.kiosk.setLaunchOnStartup(req.patch.launchOnStartup)
    if (req.patch.companion !== undefined) services.companion.applySettings()
    return result
  })

  handle('people:list', null, () => services.people.list())
  handle('people:create', s.personCreateSchema, (req) => services.people.create(req))
  handle('people:update', s.personUpdateSchema, (req) => services.people.update(req))
  handle('people:delete', s.idSchema, (req) => services.people.remove(req.id))

  handle('calendars:list', null, () => services.calendars.list())
  handle('calendars:create', s.calendarCreateSchema, (req) => services.calendars.create(req))
  handle('calendars:update', s.calendarUpdateSchema, (req) => services.calendars.update(req))
  handle('calendars:delete', s.idSchema, (req) => services.calendars.remove(req.id))

  handle('events:getOccurrences', s.occurrenceQuerySchema, (req) => services.events.getOccurrences(req))
  handle('events:get', s.idSchema, (req) => services.events.getEvent(req.id))
  handle('events:create', s.eventCreateSchema, (req) => services.events.create(req))
  handle('events:update', s.eventUpdateSchema, (req) => services.events.update(req))
  handle('events:delete', s.eventDeleteSchema, (req) => services.events.remove(req))

  handle('google:getStatus', null, () => ({
    configured: services.googleAuth.isConfigured(),
    accounts: services.googleAuth.listAccounts()
  }))
  handle('google:setCredentials', s.googleCredentialsSchema, (req) =>
    services.googleAuth.setCredentials(req.clientId, req.clientSecret)
  )
  handle('google:connect', null, async () => {
    const result = await services.googleAuth.connect()
    services.syncManager.syncNow()
    return result
  })
  handle('google:disconnect', s.accountIdSchema, (req) => services.googleAuth.disconnect(req.accountId))
  handle('google:listRemoteCalendars', s.accountIdSchema, (req) => services.googleSync.listRemoteCalendars(req.accountId))
  handle('google:setCalendarSelected', s.googleCalendarSelectSchema, (req) => {
    services.googleSync.setCalendarSelected(req)
    if (req.selected) services.syncManager.syncNow()
  })

  handle('ics:add', s.icsAddSchema, (req) => {
    const row = services.icsSync.addFeed(req)
    services.syncManager.syncNow()
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      color: row.color,
      readOnly: row.readOnly,
      visible: row.visible
    }
  })

  handle('sync:now', null, () => services.syncManager.syncNow())
  handle('sync:getStatus', null, () => services.syncManager.getStatus())

  handle('chores:list', null, () => services.chores.list())
  handle('chores:create', s.choreCreateSchema, (req) => services.chores.create(req))
  handle('chores:update', s.choreUpdateSchema, (req) => services.chores.update(req))
  handle('chores:delete', s.idSchema, (req) => services.chores.remove(req.id))
  handle('chores:getDay', s.choreDaySchema, (req) => services.chores.getDay(req.date))
  handle('chores:complete', s.choreCheckSchema, (req) => services.chores.complete(req.choreId, req.date))
  handle('chores:uncomplete', s.choreCheckSchema, (req) => services.chores.uncomplete(req.choreId, req.date))

  handle('stars:balances', null, () => services.chores.balances())

  handle('rewards:list', null, () => services.rewards.list())
  handle('rewards:create', s.rewardCreateSchema, (req) => services.rewards.create(req))
  handle('rewards:update', s.rewardUpdateSchema, (req) => services.rewards.update(req))
  handle('rewards:delete', s.idSchema, (req) => services.rewards.remove(req.id))
  handle('rewards:redeem', s.redeemSchema, (req) => services.rewards.redeem(req.rewardId, req.personId))
  handle('rewards:redemptions', null, () => services.rewards.pendingRedemptions())
  handle('rewards:grant', s.grantSchema, (req) => services.rewards.grant(req.redemptionId))

  handle('lists:getAll', null, () => services.lists.getAll())
  handle('lists:create', s.listCreateSchema, (req) => services.lists.create(req))
  handle('lists:update', s.listUpdateSchema, (req) => services.lists.update(req))
  handle('lists:delete', s.idSchema, (req) => services.lists.remove(req.id))
  handle('listItems:add', s.listItemAddSchema, (req) => services.lists.addItem(req.listId, req.text))
  handle('listItems:toggle', s.idSchema, (req) => services.lists.toggleItem(req.id))
  handle('listItems:delete', s.idSchema, (req) => services.lists.removeItem(req.id))
  handle('listItems:clearChecked', s.listIdSchema, (req) => services.lists.clearChecked(req.listId))

  handle('meals:getRange', s.mealsRangeSchema, (req) => services.meals.getRange(req.start, req.end))
  handle('meals:set', s.mealSetSchema, (req) => services.meals.set(req.date, req.slot, req.text))

  handle('rss:getFeed', s.rssFeedSchema, (req) => services.rss.getFeed(req.feedId))

  handle('birdnet:getDetections', s.birdnetUrlSchema, (req) => services.birdnet.getDetections(req.url))

  handle('camera:list', null, () => services.camera.list())
  handle('camera:add', s.cameraAddSchema, (req) => services.camera.add(req.name, req.url))
  handle('camera:remove', s.cameraIdSchema, (req) => services.camera.remove(req.cameraId))
  handle('camera:start', s.cameraIdSchema, (req) => services.camera.start(req.cameraId))
  handle('camera:stop', s.cameraSessionSchema, (req) => services.camera.stop(req.sessionId))

  handle('weather:get', null, () => services.weather.get())
  handle('weather:searchCity', s.citySearchSchema, (req) => services.weather.searchCity(req.query))

  handle('screensaver:pickFolder', null, () => services.kiosk.pickFolder())
  handle('screensaver:listPhotos', null, () => services.kiosk.listPhotos())
  handle('kiosk:previewScreensaver', null, () => services.kiosk.previewScreensaver())

  handle('companion:getStatus', null, () => services.companion.getStatus())
  handle('companion:issueToken', null, () => services.companion.issueToken())
  handle('companion:unpairAll', null, () => services.companion.unpairAll())

  handle('auth:getStatus', null, () => ({
    pinSet: services.auth.pinSet(),
    unlocked: services.auth.isUnlocked()
  }))
  handle('auth:verifyPin', s.pinVerifySchema, (req) => ({ valid: services.auth.verifyPin(req.pin) }))
  handle('auth:setPin', s.pinSetSchema, (req) => services.auth.setPin(req.pin))
  handle('auth:lock', null, () => services.auth.lock())

  return table
}
