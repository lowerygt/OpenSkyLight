import { ipcMain, BrowserWindow } from 'electron'
import type { ChannelTable, Services } from './core'
import { dispatch } from './core'

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpcHandlers(services: Services, table: ChannelTable): void {
  for (const channel of table.keys()) {
    ipcMain.handle(channel, (_event, payload) =>
      dispatch(services, table, channel, payload, { gate: 'pin', broadcast })
    )
  }
}
