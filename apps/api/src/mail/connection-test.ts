/**
 * IMAP/SMTP connection test (roadmap 2.1): connects, authenticates and
 * returns a machine-readable result with a human-understandable message.
 *
 * Error mapping turns low-level errors into stable codes the frontend can
 * translate: AUTH_FAILED, HOST_NOT_FOUND, BLOCKED_HOST, BLOCKED_PORT, CONNECTION_REFUSED,
 * TIMEOUT, TLS_ERROR, TLS_REQUIRED, UNKNOWN.
 *
 * Every connection goes through `@fma/shared/mail-transport` (SSRF check on
 * the resolved address, mandatory STARTTLS on plain ports).
 */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import {
  imapTransportOptions,
  isStartTlsUnavailable,
  smtpTransportOptions,
  type MailTransportPolicy,
} from '@fma/shared/mail-transport'

export { isSecurePort } from '@fma/shared/mail-transport'

export interface TestResult {
  ok: boolean
  code?: string
  message?: string
  /** IMAP capabilities, filled on success (e.g. IDLE, CONDSTORE, QRESYNC). */
  capabilities?: string[]
}

export interface HostConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

const CONNECT_TIMEOUT_MS = 15_000

/** Minimal logger shape (the request's redacting pino logger). */
export interface WarnLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

export interface TestOptions {
  /** Redacting logger; only error name/code are logged, never server texts. */
  log?: WarnLogger
  /** Test override of the transport policy (default: environment). */
  policy?: MailTransportPolicy
}

function classifyError(err: unknown): { code: string; message: string } {
  const text = String((err as Error)?.message ?? err)
  const code = (err as { code?: string; authenticationFailed?: boolean }) ?? {}

  // Refused before connecting: port outside the allowlist (ASVS N2).
  if (code.code === 'PORT_NOT_ALLOWED') {
    return {
      code: 'BLOCKED_PORT',
      message: 'Port nicht erlaubt (IMAP 143/993, SMTP 25/465/587/2525).',
    }
  }
  // Refused before LOGIN/AUTH, so it is never an auth failure.
  if (isStartTlsUnavailable(err)) {
    return {
      code: 'TLS_REQUIRED',
      message:
        'Der Server bietet keine verschlüsselte Verbindung (STARTTLS) an – das Passwort wurde nicht gesendet. Einen TLS-Port (IMAP 993, SMTP 465) verwenden oder den Anbieter prüfen.',
    }
  }
  if (
    code.authenticationFailed ||
    /AUTHENTICATIONFAILED|invalid credentials|535 |530 /i.test(text)
  ) {
    return { code: 'AUTH_FAILED', message: 'Zugangsdaten wurden abgelehnt.' }
  }
  if (code.code === 'ENOTFOUND' || code.code === 'EAI_AGAIN' || /ENOTFOUND/i.test(text)) {
    return { code: 'HOST_NOT_FOUND', message: 'Host nicht gefunden - bitte Namen prüfen.' }
  }
  if (code.code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(text)) {
    return { code: 'CONNECTION_REFUSED', message: 'Verbindung abgelehnt - Host/Port prüfen.' }
  }
  if (
    code.code === 'ETIMEDOUT' ||
    code.code === 'ESOCKETTIMEDOUT' ||
    /timed out|timeout/i.test(text)
  ) {
    return { code: 'TIMEOUT', message: 'Zeitüberschreitung beim Verbinden.' }
  }
  if (/certificate|TLS|SSL|self-signed/i.test(text)) {
    return {
      code: 'TLS_ERROR',
      message: 'TLS-Fehler - Zertifikat des Servers konnte nicht verifiziert werden.',
    }
  }
  if (code.code === 'PRIVATE_HOST_BLOCKED' || text.includes('private address')) {
    return { code: 'BLOCKED_HOST', message: 'Interner Host ist blockiert (SSRF-Schutz).' }
  }
  // No server text: it may echo user data or leak banners of internal hosts.
  return { code: 'UNKNOWN', message: 'Verbindung fehlgeschlagen.' }
}

function logFailure(log: WarnLogger | undefined, stage: string, err: unknown, code: string): void {
  const error = (err ?? {}) as { name?: unknown; code?: unknown }
  log?.warn(
    {
      stage,
      code,
      errName: typeof error.name === 'string' ? error.name : undefined,
      errCode: typeof error.code === 'string' ? error.code : undefined,
    },
    'connection test failed',
  )
}

/** Tests IMAP: connect + login + capability list. */
export async function testImap(config: HostConfig, options: TestOptions = {}): Promise<TestResult> {
  let client: ImapFlow | null = null
  try {
    client = new ImapFlow({
      ...(await imapTransportOptions(config, options.policy)),
      auth: { user: config.user, pass: config.password },
      logger: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
    })

    await client.connect()
    // imapflow 2.x: `capabilities` is a Map (capability name -> flag); older
    // versions expose a Set and/or rawCapabilities.
    const flow = client as unknown as {
      rawCapabilities?: Set<unknown>
      capabilities?: Map<unknown, unknown> | Set<unknown>
    }
    const source = flow.rawCapabilities ?? flow.capabilities ?? new Set<unknown>()
    const names = source instanceof Map ? [...source.keys()] : [...source]
    const capabilities = names.map((c) =>
      typeof c === 'string'
        ? c
        : String(
            (c as { id?: unknown; value?: unknown }).id ?? (c as { value?: unknown }).value ?? c,
          ),
    )
    return { ok: true, capabilities }
  } catch (err) {
    const { code, message } = classifyError(err)
    logFailure(options.log, 'imap', err, code)
    return { ok: false, code, message }
  } finally {
    client?.close()
  }
}

/** Tests SMTP: connect + authenticate via nodemailer's verify(). */
export async function testSmtp(config: HostConfig, options: TestOptions = {}): Promise<TestResult> {
  let transport
  try {
    transport = await smtpTransportOptions(config, options.policy)
  } catch (err) {
    const { code, message } = classifyError(err)
    logFailure(options.log, 'smtp', err, code)
    return { ok: false, code, message }
  }

  const transporter = nodemailer.createTransport({
    ...transport,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
  })

  try {
    await transporter.verify()
    return { ok: true }
  } catch (err) {
    const { code, message } = classifyError(err)
    logFailure(options.log, 'smtp', err, code)
    return { ok: false, code, message }
  } finally {
    transporter.close()
  }
}
