import { assertPublicHost } from '@fma/shared/ssrf'

/** Implicit TLS for IMAP 993 / SMTP 465, otherwise plain/STARTTLS. */
export function isSecurePort(port: number): boolean {
  return port === 993 || port === 465
}

/** Short-lived test mode for CI/local GreenMail (plain ports, self-signed). */
export function mailTestMode(): boolean {
  return process.env.MAIL_ALLOW_PRIVATE_HOSTS === '1'
}

/**
 * SSRF guard before every provider connection: the user-provided host must
 * resolve to public addresses only (skipped in test mode, GreenMail is local).
 */
export async function assertMailHost(host: string): Promise<void> {
  if (!mailTestMode()) await assertPublicHost(host)
}
