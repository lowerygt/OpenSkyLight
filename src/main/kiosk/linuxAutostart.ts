import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Linux launch-on-startup. Electron's setLoginItemSettings is a no-op on Linux,
 * so we write an XDG autostart entry instead (honoured by GNOME, Cinnamon, KDE, XFCE…).
 */
export function autostartPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'autostart', 'openskylight.desktop')
}

function quoteExec(arg: string): string {
  // Desktop Entry spec: quote args containing reserved characters
  return /[\s"'\\$`]/.test(arg) ? `"${arg.replace(/(["\\$`])/g, '\\$1')}"` : arg
}

export function autostartEntry(execPath: string, args: string[] = []): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=OpenSkyLight',
    `Exec=${[execPath, ...args].map(quoteExec).join(' ')}`,
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=false',
    'Terminal=false',
    ''
  ].join('\n')
}

export function setLinuxAutostart(enabled: boolean, execPath: string, args: string[] = []): void {
  const file = autostartPath()
  if (enabled) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, autostartEntry(execPath, args), 'utf8')
  } else {
    rmSync(file, { force: true })
  }
}

export function isLinuxAutostartEnabled(): boolean {
  return existsSync(autostartPath())
}
