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
 * Test/CI note: integration tests run against a local GreenMail container,
 * which is only reachable via loopback/private addresses. Set
 * MAIL_ALLOW_PRIVATE_HOSTS=1 there (never in production).
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class PrivateHostError extends Error {
  readonly code = 'PRIVATE_HOST_BLOCKED'
  constructor(host: string) {
    super(`Host "${host}" resolves to a private address and cannot be used`)
  }
}

interface ResolvedAddress {
  address: string
  family: number
}

type Lookup = (
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

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return false // unspecified/loopback
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return false // link-local fe80::/10
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false // unique local fc00::/7
  if (normalized.startsWith('ff')) return false // multicast
  if (normalized.startsWith('::ffff:')) {
    // IPv4-mapped: validate the embedded IPv4 part.
    return isPublicIpv4(normalized.slice('::ffff:'.length))
  }
  if (normalized.startsWith('64:ff9b:')) return false // NAT64 (embeds IPv4)
  if (normalized.startsWith('2001:db8:')) return false // documentation
  if (normalized.startsWith('2002:')) {
    // 6to4: the first 32 bits after the prefix embed an IPv4 address -
    // validate that prefix against the IPv4 rules.
    const firstGroup = normalized.slice('2002:'.length).split(':')[0] ?? ''
    if (firstGroup.length !== 8) return true // rare/malformed, treat as public
    const a = Number.parseInt(firstGroup.slice(0, 2), 16)
    const b = Number.parseInt(firstGroup.slice(2, 4), 16)
    return isPublicIpv4(`${a}.${b}.1.1`)
  }
  if (
    normalized.startsWith('fec') ||
    normalized.startsWith('fed') ||
    normalized.startsWith('fee') ||
    normalized.startsWith('fef')
  ) {
    return false // deprecated site-local fec0::/10
  }
  if (normalized.startsWith('100:')) return false // discard-only 100::/64
  return true
}
