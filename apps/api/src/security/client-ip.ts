/**
 * Client IP behind the reverse proxy (roadmap 6.4), used for rate limits and
 * the login lockout.
 *
 * Only the direct peer is trusted as a proxy, and only when it has a
 * loopback/private address (caddy in the compose network, or the operator's
 * own proxy on the same host/LAN). Then the right-most X-Forwarded-For entry
 * (the address that proxy saw) is the client IP; anything a client wrote
 * further left is ignored, so X-Forwarded-For cannot be spoofed from outside.
 * A request from a public address directly to the api uses the socket
 * address and ignores X-Forwarded-For entirely.
 *
 * Caddy replaces an incoming X-Forwarded-For by default (no
 * trusted_proxies configured), so behind caddy the value is the real client.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net'

const privateRanges = new BlockList()
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4')
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4')
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4')
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4')
privateRanges.addAddress('::1', 'ipv6')
privateRanges.addSubnet('fc00::', 7, 'ipv6')

export function isPrivateAddress(address: string): boolean {
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  const addr = v4Mapped?.[1] ?? address
  if (isIPv4(addr)) return privateRanges.check(addr, 'ipv4')
  if (isIPv6(addr)) return privateRanges.check(addr, 'ipv6')
  return false
}

/** Fastify `trustProxy` function: trust exactly one private hop. */
export function trustOnePrivateProxy(address: string, hop: number): boolean {
  return hop === 0 && isPrivateAddress(address)
}
