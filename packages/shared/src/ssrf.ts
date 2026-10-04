/**
 * SSRF protection for user-provided mail hosts (roadmap 2.1 acceptance:
 * "interne IPs blockiert").
 *
 * The api must never be abused to reach internal infrastructure, so mail
 * hosts are resolved and every resolved address is checked against
 * private/loopback/link-local/reserved ranges before connecting. Shared by
 * the api (connection test) and the worker (SMTP send, roadmap 2.7); import
 * via `@fma/shared/ssrf` (node-only, not part of the browser-safe index).
 *
 * Exception: MAIL_ALLOW_PRIVATE_HOSTS=1 allows private mail hosts (own
 * server in the LAN, local GreenMail in tests); see mail-transport.ts.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class PrivateHostError extends Error {
  readonly code = 'PRIVATE_HOST_BLOCKED'
  constructor(host: string) {
    super(`Host "${host}" resolves to a private address and cannot be used`)
  }
}

export interface ResolvedAddress {
  address: string
  family: number
}

export type Lookup = (
  hostname: string,
  options: { all: true },
) => Promise<{ address: string; family: number }[]>

/** Injects the resolver for tests; defaults to node:dns/promises lookup. */
export async function assertPublicHost(
  host: string,
  lookup: Lookup = dnsLookup,
): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[]
  if (isIP(host)) {
    // Literal IP: no DNS involved, validate directly.
    addresses = [{ address: host, family: isIP(host) }]
  } else {
    addresses = await lookup(host, { all: true })
  }

  if (addresses.length === 0) {
    throw new PrivateHostError(host)
  }
  for (const { address } of addresses) {
    if (!isPublicIp(address)) {
      throw new PrivateHostError(host)
    }
  }
  return addresses
}

/** True for public unicast addresses; false for everything internal/special. */
export function isPublicIp(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]

  if (a === 0) return false // "this network"
  if (a === 10) return false // private
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local
  if (a === 172 && b >= 16 && b <= 31) return false // private
  if (a === 192 && b === 168) return false // private
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 192 && b === 0) return false // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51) return false // TEST-NET-2
  if (a === 203 && b === 0) return false // TEST-NET-3
  if (a >= 224) return false // multicast + reserved
  return true
}

/** IPv4 address embedded in the last 32 bits of an expanded IPv6 address. */
function embeddedIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/**
 * Works on the fully expanded eight groups, so every spelling of the same
 * address (`::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1`, `0::ffff:...`,
 * upper case) is classified identically. Ranges that embed an IPv4 address
 * are checked against the IPv4 rules.
 */
function isPublicIpv6(address: string): boolean {
  // Zone IDs (fe80::1%eth0) only make sense for link-local targets.
  if (address.includes('%')) return false
  const groups = expandIpv6(address.toLowerCase())
  if (!groups) return false
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const ipv4 = embeddedIpv4(g6, g7)

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    // ::/96 IPv4-compatible (incl. :: and ::1, which embed 0.0.0.0/0.0.0.1).
    if (g4 === 0 && g5 === 0) return isPublicIpv4(ipv4)
    // ::ffff:0:0/96 IPv4-mapped.
    if (g4 === 0 && g5 === 0xffff) return isPublicIpv4(ipv4)
    // ::ffff:0:0:0/96 IPv4-translated (SIIT).
    if (g4 === 0xffff && g5 === 0) return isPublicIpv4(ipv4)
    return false // rest of ::/64 is reserved
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    // NAT64 well-known prefix 64:ff9b::/96 embeds the IPv4 target;
    // 64:ff9b:1::/48 is the local-use NAT64 prefix (RFC 8215).
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicIpv4(ipv4)
    return false
  }
  if (g0 === 0x2002) {
    // 6to4 (2002:AABB:CCDD::/48): groups 1 and 2 embed AA.BB.CC.DD.
    return isPublicIpv4(embeddedIpv4(g1, g2))
  }
  if (g0 === 0x2001 && g1 === 0) return false // Teredo 2001::/32 (obfuscated IPv4)
  if (g0 === 0x2001 && g1 === 0xdb8) return false // documentation 2001:db8::/32
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false // documentation 3fff::/20
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false // discard-only 100::/64
  if ((g0 & 0xffc0) === 0xfe80) return false // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false // deprecated site-local fec0::/10
  if ((g0 & 0xfe00) === 0xfc00) return false // unique local fc00::/7
  if ((g0 & 0xff00) === 0xff00) return false // multicast ff00::/8
  return true
}

/** The eight 16-bit groups of an IPv6 address (`::` and a trailing IPv4 expanded). */
function expandIpv6(address: string): number[] | null {
  let text = address
  const ipv4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (ipv4) {
    const [a = 0, b = 0, c = 0, d = 0] = ipv4.split('.').map(Number)
    text =
      text.slice(0, -ipv4.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail, ...rest] = text.split('::')
  if (rest.length > 0) return null
  const parse = (part: string) => (part ? part.split(':').map((g) => Number.parseInt(g, 16)) : [])
  const headGroups = parse(head)
  const tailGroups = tail === undefined ? [] : parse(tail)
  const missing = 8 - headGroups.length - tailGroups.length
  if (tail === undefined ? missing !== 0 : missing < 1) return null
  const groups = [...headGroups, ...Array<number>(Math.max(missing, 0)).fill(0), ...tailGroups]
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : groups
}
