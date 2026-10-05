/**
 * Central transport policy for every IMAP/SMTP connection to a provider
 * (api connection test + search, all worker jobs, IDLE). Node-only, import
 * via `@fma/shared/mail-transport`.
 *
 * - SSRF: the host is resolved once and every address must be public
 *   (`assertPublicHost`). The connection then goes to the checked address,
 *   with the original hostname as TLS servername (SNI + certificate check),
 *   so a second DNS answer cannot redirect it to an internal target
 *   (DNS rebinding).
 * - Transport security: implicit TLS on 993/465; on every other port
 *   STARTTLS is mandatory (ImapFlow `doSTARTTLS: true`, nodemailer
 *   `requireTLS: true`). A server (or an attacker stripping the capability)
 *   without STARTTLS is rejected before LOGIN/AUTH, so passwords never go
 *   over the wire in plain text.
 *
 * Environment switches (independent of each other):
 * - MAIL_ALLOW_PRIVATE_HOSTS=1 skips the SSRF check, e.g. for an own mail
 *   server in the LAN. STARTTLS and certificate checks stay mandatory.
 * - MAIL_INSECURE_TRANSPORT=1 (dev/test only, GreenMail on plain ports with
 *   a self-signed certificate) disables STARTTLS and certificate checks.
 *   Never set it in production.
 */
import { isIP } from 'node:net'
import { assertPublicHost, type Lookup } from './ssrf'

/** True when MAIL_ALLOW_PRIVATE_HOSTS=1: private/LAN mail hosts allowed (TLS stays on). */
export function allowPrivateMailHosts(): boolean {
  return process.env.MAIL_ALLOW_PRIVATE_HOSTS === '1'
}

/**
 * True when MAIL_INSECURE_TRANSPORT=1 (dev/test only): plain text without
 * STARTTLS, no certificate check; also lets push go to local http fakes.
 */
export function mailTestMode(): boolean {
  return process.env.MAIL_INSECURE_TRANSPORT === '1'
}

/** Implicit TLS for IMAP 993 / SMTP 465, otherwise STARTTLS. */
export function isSecurePort(port: number): boolean {
  return port === 993 || port === 465
}

export interface MailEndpoint {
  host: string
  port: number
  secure: boolean
}

/**
 * Overrides for tests; production code passes nothing and gets the policy
 * from the environment.
 */
export interface MailTransportPolicy {
  /** Skip the SSRF check (default: MAIL_ALLOW_PRIVATE_HOSTS=1). */
  allowPrivateHosts?: boolean
  /** No certificate check, no STARTTLS (default: MAIL_INSECURE_TRANSPORT=1). */
  insecureTransport?: boolean
  /** DNS resolver (default: node:dns/promises lookup). */
  lookup?: Lookup
}

interface ConnectTarget {
  /** Address to connect to (checked IP, or the host as configured). */
  host: string
  /** Original hostname for SNI and certificate verification. */
  servername?: string
  insecure: boolean
}

async function resolveTarget(host: string, policy: MailTransportPolicy): Promise<ConnectTarget> {
  const insecure = policy.insecureTransport ?? mailTestMode()
  if (policy.allowPrivateHosts ?? allowPrivateMailHosts()) return { host, insecure }
  const addresses = await assertPublicHost(host, policy.lookup)
  // Prefer IPv4: containers (rootless Docker) often lack IPv6 routes, and
  // connecting to a fixed address skips Node's happy-eyeballs fallback.
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0]!
  return { host: chosen.address, servername: isIP(host) ? undefined : host, insecure }
}

export interface ImapTransportOptions {
  host: string
  port: number
  secure: boolean
  servername?: string
  doSTARTTLS?: boolean
  tls?: { rejectUnauthorized?: boolean; servername?: string }
}

/**
 * SSRF check + connection options for ImapFlow. Throws PrivateHostError
 * (code PRIVATE_HOST_BLOCKED) or the DNS error before anything connects.
 */
export async function imapTransportOptions(
  endpoint: MailEndpoint,
  policy: MailTransportPolicy = {},
): Promise<ImapTransportOptions> {
  const target = await resolveTarget(endpoint.host, policy)
  const base = { host: target.host, port: endpoint.port, secure: endpoint.secure }
  if (target.insecure) {
    // GreenMail: plain ports, self-signed certificate.
    return { ...base, tls: { rejectUnauthorized: false }, doSTARTTLS: false }
  }
  return {
    ...base,
    ...(target.servername
      ? { servername: target.servername, tls: { servername: target.servername } }
      : {}),
    // ImapFlow refuses doSTARTTLS together with secure=true.
    ...(endpoint.secure ? {} : { doSTARTTLS: true }),
  }
}

export interface SmtpTransportOptions {
  host: string
  port: number
  secure: boolean
  servername?: string
  requireTLS?: boolean
  ignoreTLS?: boolean
  tls?: { rejectUnauthorized?: boolean; servername?: string }
}

/** SSRF check + connection options for nodemailer (see imapTransportOptions). */
export async function smtpTransportOptions(
  endpoint: MailEndpoint,
  policy: MailTransportPolicy = {},
): Promise<SmtpTransportOptions> {
  const target = await resolveTarget(endpoint.host, policy)
  const base = { host: target.host, port: endpoint.port, secure: endpoint.secure }
  if (target.insecure) {
    return { ...base, tls: { rejectUnauthorized: false }, ignoreTLS: true }
  }
  return {
    ...base,
    ...(target.servername
      ? { servername: target.servername, tls: { servername: target.servername } }
      : {}),
    ...(endpoint.secure ? {} : { requireTLS: true }),
  }
}

/**
 * True when the connection was refused because the server does not offer
 * STARTTLS (or an attacker stripped it): the stable code is TLS_REQUIRED.
 * Matches the library-generated messages only, never provider texts.
 */
export function isStartTlsUnavailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const error = err as { tlsFailed?: unknown; code?: unknown; command?: unknown; message?: unknown }
  const message = typeof error.message === 'string' ? error.message : ''
  // ImapFlow (doSTARTTLS: true): capability missing or STARTTLS rejected.
  if (error.tlsFailed === true && /does not support STARTTLS/i.test(message)) return true
  // nodemailer (requireTLS: true): STARTTLS answered with an error, or no
  // EHLO (HELO cannot negotiate STARTTLS).
  if (error.code === 'ETLS' && error.command === 'STARTTLS') {
    return /Error upgrading connection with STARTTLS/i.test(message)
  }
  return error.code === 'ECONNECTION' && /does not support required STARTTLS/i.test(message)
}
