/**
 * IMAP/SMTP connection test (roadmap 2.1): connects, authenticates and
 * returns a machine-readable result with a human-understandable message.
 *
 * Error mapping turns low-level errors into stable codes the frontend can
 * translate: AUTH_FAILED, HOST_NOT_FOUND, BLOCKED_HOST, CONNECTION_REFUSED,
 * TIMEOUT, TLS_ERROR, UNKNOWN.
 */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { assertPublicHost } from './ssrf'

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

/** Implicit TLS for 993/465, otherwise plain/STARTTLS. */
export function isSecurePort(port: number): boolean {
  return port === 993 || port === 465
}

/** Short-lived test mode for CI/local GreenMail (plain ports, self-signed). */
function testMode(): boolean {
  return process.env.MAIL_ALLOW_PRIVATE_HOSTS === '1'
}

function classifyError(err: unknown): { code: string; message: string } {
  const text = String((err as Error)?.message ?? err)
  const code = (err as { code?: string; authenticationFailed?: boolean }) ?? {}

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
  if (text.includes('private address')) {
    return { code: 'BLOCKED_HOST', message: 'Interner Host ist blockiert (SSRF-Schutz).' }
  }
  return { code: 'UNKNOWN', message: `Verbindung fehlgeschlagen: ${text.slice(0, 200)}` }
}

/** Tests IMAP: connect + login + capability list. */
export async function testImap(config: HostConfig): Promise<TestResult> {
  let client: ImapFlow | null = null
  try {
    if (!testMode()) await assertPublicHost(config.host)

    client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      logger: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      tls: testMode() ? { rejectUnauthorized: false } : undefined,
      // Test mode talks to plain GreenMail ports even when STARTTLS is offered.
      ...(testMode() ? { doSTARTTLS: false as const } : {}),
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
    // Full stack server-side for every failure, so bundling/platform quirks
    // are diagnosable without leaking internals to the client.
    console.warn('[connection-test] imap error:', err)
    const { code, message } = classifyError(err)
    return { ok: false, code, message }
  } finally {
    client?.close()
  }
}

/** Tests SMTP: connect + authenticate via nodemailer's verify(). */
export async function testSmtp(config: HostConfig): Promise<TestResult> {
  try {
    if (!testMode()) await assertPublicHost(config.host)
  } catch (err) {
    const { code, message } = classifyError(err)
    return { ok: false, code, message }
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    tls: testMode() ? { rejectUnauthorized: false } : undefined,
    ignoreTLS: testMode(),
  })

  try {
    await transporter.verify()
    return { ok: true }
  } catch (err) {
    const { code, message } = classifyError(err)
    return { ok: false, code, message }
  } finally {
    transporter.close()
  }
}
