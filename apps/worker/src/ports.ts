/** Implicit TLS for IMAP 993 / SMTP 465, otherwise plain/STARTTLS. */
export function isSecurePort(port: number): boolean {
  return port === 993 || port === 465
}

/** Short-lived test mode for CI/local GreenMail (plain ports, self-signed). */
export function mailTestMode(): boolean {
  return process.env.MAIL_ALLOW_PRIVATE_HOSTS === '1'
}
