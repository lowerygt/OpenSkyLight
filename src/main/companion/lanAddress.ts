import os from 'node:os'

/** Pure (interfaces injectable) so the ranking is unit-testable on fixtures. */

// Windows adapter names, then Linux ones (docker/libvirt bridges, VPN tunnels, WireGuard, ZeroTier)
const VIRTUAL_NAME =
  /(vEthernet|WSL|Hyper-V|VirtualBox|VMware|vmnet|Tailscale|ZeroTier|Loopback|docker|veth|^br-|^virbr|^tun|^wg|^zt)/i

function isRfc1918(ip: string): boolean {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  )
}

/**
 * IPv4 addresses a phone on the home network could plausibly reach, best
 * guess first: real-NIC RFC1918 addresses, then virtual-adapter RFC1918
 * (Hyper-V etc — usually wrong but shown as alternates), then anything else.
 */
export function pickLanAddresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const candidates: { ip: string; score: number }[] = []
  for (const [name, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (info.address.startsWith('169.254.')) continue // link-local = no DHCP, useless
      let score = 0
      if (isRfc1918(info.address)) score += 2
      if (!VIRTUAL_NAME.test(name)) score += 1
      candidates.push({ ip: info.address, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return [...new Set(candidates.map((c) => c.ip))]
}
