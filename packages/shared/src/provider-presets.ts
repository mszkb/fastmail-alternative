import type { OAuthProviderId } from './oauth'

/**
 * Provider presets for the account form (#117): server, ports and TLS of
 * common providers, taken from docs/product/mail-providers.md, plus a short
 * German hint how to get the password the provider expects. Ports 993/465
 * are implicit TLS; the user name is the full address everywhere.
 *
 * Kept free of DOM access so native clients can share the list.
 */

export type ProviderAuth = 'password' | 'app-password' | 'oauth-only'

export interface ProviderPreset {
  id: string
  label: string
  imap: { host: string; port: number }
  smtp: { host: string; port: number }
  auth: ProviderAuth
  /** German hint shown with the preset (how to get the password). */
  hint: string
  /** Address domains that select this preset automatically. */
  domains: string[]
  /** Sign-in with this OAuth provider when the server has it configured (#36). */
  oauth?: OAuthProviderId
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'fastmail',
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993 },
    smtp: { host: 'smtp.fastmail.com', port: 465 },
    auth: 'app-password',
    hint:
      'Fastmail verlangt ein App-Passwort: In den Fastmail-Einstellungen unter „Privatsphäre & ' +
      'Sicherheit“ ein neues App-Passwort mit Zugriff auf „Mail (IMAP/POP/SMTP)“ anlegen und hier ' +
      'eintragen – nicht das normale Login-Passwort.',
    domains: [
      'fastmail.com',
      'fastmail.fm',
      'fastmail.de',
      'fastmail.net',
      'fastmail.org',
      'fastmail.to',
      'messagingengine.com',
    ],
  },
  {
    id: 'posteo',
    label: 'Posteo',
    imap: { host: 'posteo.de', port: 993 },
    smtp: { host: 'posteo.de', port: 465 },
    auth: 'password',
    hint: 'Posteo: das normale Passwort des Postfachs verwenden.',
    domains: ['posteo.de', 'posteo.net', 'posteo.org', 'posteo.eu'],
  },
  {
    id: 'mailbox-org',
    label: 'mailbox.org',
    imap: { host: 'imap.mailbox.org', port: 993 },
    smtp: { host: 'smtp.mailbox.org', port: 465 },
    auth: 'password',
    hint: 'mailbox.org: das normale Passwort des Postfachs verwenden.',
    domains: ['mailbox.org'],
  },
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 465 },
    auth: 'app-password',
    hint:
      'Google verlangt ein App-Passwort (nur mit aktivierter Bestätigung in zwei Schritten): im ' +
      'Google-Konto unter „Sicherheit“ → „App-Passwörter“ anlegen. Labels erscheinen als Ordner.',
    domains: ['gmail.com', 'googlemail.com'],
    oauth: 'google',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993 },
    smtp: { host: 'smtp.mail.me.com', port: 587 },
    auth: 'app-password',
    hint:
      'iCloud verlangt ein app-spezifisches Passwort: unter account.apple.com → „Anmelden und ' +
      'Sicherheit“ → „App-spezifische Passwörter“ anlegen. Benutzer ist die iCloud-Adresse.',
    domains: ['icloud.com', 'me.com', 'mac.com'],
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993 },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465 },
    auth: 'app-password',
    hint: 'Yahoo verlangt ein App-Passwort: in den Kontosicherheits-Einstellungen anlegen.',
    domains: ['yahoo.com', 'yahoo.de', 'ymail.com'],
  },
  {
    id: 'gmx',
    label: 'GMX',
    imap: { host: 'imap.gmx.net', port: 993 },
    smtp: { host: 'mail.gmx.net', port: 587 },
    auth: 'password',
    hint: 'GMX: IMAP-Zugriff muss im Webmail unter „E-Mail-Einstellungen“ → „POP3/IMAP Abruf“ eingeschaltet sein.',
    domains: ['gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'],
  },
  {
    id: 'webde',
    label: 'Web.de',
    imap: { host: 'imap.web.de', port: 993 },
    smtp: { host: 'smtp.web.de', port: 587 },
    auth: 'password',
    hint: 'Web.de: IMAP-Zugriff muss im Webmail unter „Einstellungen“ → „POP3/IMAP“ eingeschaltet sein.',
    domains: ['web.de'],
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365 / Outlook.com',
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp.office365.com', port: 587 },
    auth: 'oauth-only',
    hint:
      'Microsoft erlaubt nur noch die Anmeldung über Microsoft (OAuth2), nicht mit Passwort. ' +
      'Dafür muss der Betreiber dieses Servers die Anmeldung einrichten ' +
      '(docs/operations/oauth.md).',
    domains: [
      'outlook.com',
      'outlook.de',
      'hotmail.com',
      'hotmail.de',
      'live.com',
      'live.de',
      'msn.com',
    ],
    oauth: 'microsoft',
  },
]

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/** The preset matching the domain of an address, if any (case-insensitive). */
export function presetForAddress(address: string): ProviderPreset | undefined {
  const domain = address.trim().toLowerCase().split('@')[1]
  if (!domain) return undefined
  return PROVIDER_PRESETS.find((p) => p.domains.includes(domain))
}

/** Form values a preset fills in; the user name is the full address. */
export function presetFields(
  preset: ProviderPreset,
  address: string,
): { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; user: string } {
  return {
    imapHost: preset.imap.host,
    imapPort: preset.imap.port,
    smtpHost: preset.smtp.host,
    smtpPort: preset.smtp.port,
    user: address.trim(),
  }
}

/** A server found by `GET /api/autoconfig` (#165). */
export interface AutoconfigServer {
  host: string
  port: number
}

export type AutoconfigSource = 'autoconfig' | 'well-known' | 'ispdb' | 'srv' | 'mx'

/** Response of `GET /api/autoconfig?domain=` (#165). */
export interface AutoconfigResponse {
  found: boolean
  source?: AutoconfigSource
  imap?: AutoconfigServer
  smtp?: AutoconfigServer | null
  /** User name the provider expects: the full address or its local part. */
  username?: 'address' | 'localpart'
}

/** German names of the sources, for the hint under the detected values. */
export const AUTOCONFIG_SOURCE_LABELS: Record<AutoconfigSource, string> = {
  autoconfig: 'Autoconfig des Anbieters',
  'well-known': 'Autoconfig des Anbieters',
  ispdb: 'Thunderbird-Anbieterdatenbank',
  srv: 'DNS-Einträge der Domain',
  mx: 'Mailserver der Domain (MX) und Thunderbird-Anbieterdatenbank',
}

const DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/**
 * The domain to detect settings for: only for a complete address whose
 * domain has no preset (presets win and need no request).
 */
export function autoconfigDomain(address: string): string | undefined {
  const parts = address.trim().toLowerCase().split('@')
  if (parts.length !== 2 || !parts[0]) return undefined
  const domain = parts[1]!.replace(/\.$/, '')
  if (!DOMAIN_RE.test(domain) || presetForAddress(address)) return undefined
  return domain
}

/** Form values from a detection result; SMTP stays undefined when none was found. */
export function autoconfigFields(
  result: AutoconfigResponse,
  address: string,
):
  | {
      imapHost: string
      imapPort: number
      smtpHost?: string
      smtpPort?: number
      user: string
    }
  | undefined {
  if (!result.found || !result.imap) return undefined
  const trimmed = address.trim()
  const user = result.username === 'localpart' ? trimmed.split('@')[0]! : trimmed
  return {
    imapHost: result.imap.host,
    imapPort: result.imap.port,
    ...(result.smtp ? { smtpHost: result.smtp.host, smtpPort: result.smtp.port } : {}),
    user,
  }
}
