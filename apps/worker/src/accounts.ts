/**
 * Loads an account's crypto context (DEK) and IMAP/SMTP credentials from the
 * database, decrypting them with the account DEK (envelope encryption,
 * @fma/crypto).
 */
import type { Pool } from '@fma/db'
import { decryptField, unwrapAccountKey } from '@fma/crypto'
import { isSecurePort } from './ports'

export interface AccountImapConfig {
  host: string
  port: number
  secure: boolean
}

export interface AccountContext {
  accountId: string
  emailAddress: string
  /** Data key of the account, unwrapped (never log or persist this). */
  dek: Buffer
  imap: AccountImapConfig & { user: string; password: string }
  /** SMTP credentials fall back to the IMAP ones (same as account creation). */
  smtp: AccountImapConfig & { user: string; password: string }
}

export async function loadAccountContext(
  pool: Pool,
  accountId: string,
  masterKeyBase64: string,
): Promise<AccountContext> {
  const { rows } = await pool.query<{
    id: string
    email_address: string
    imap_host: string
    imap_port: number
    smtp_host: string
    smtp_port: number
    wrapped_dek: Buffer
    key_id: string
    credential_enc: Buffer
  }>(
    `SELECT id, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id,
            credential_enc
     FROM mail_account WHERE id = $1`,
    [accountId],
  )
  const row = rows[0]
  if (!row) throw new Error(`account ${accountId} not found`)

  const dataKey = unwrapAccountKey(masterKeyBase64, row.wrapped_dek)
  const credentialsJson = decryptField(
    dataKey,
    row.credential_enc.toString('utf8'),
    `mail_account.credential:${row.id}`,
  )
  const credentials = JSON.parse(credentialsJson) as {
    imapUser: string
    imapPassword: string
    smtpUser?: string
    smtpPassword?: string
  }

  return {
    accountId: row.id,
    emailAddress: row.email_address,
    dek: dataKey,
    imap: {
      host: row.imap_host,
      port: row.imap_port,
      secure: isSecurePort(row.imap_port),
      user: credentials.imapUser,
      password: credentials.imapPassword,
    },
    smtp: {
      host: row.smtp_host,
      port: row.smtp_port,
      secure: isSecurePort(row.smtp_port),
      user: credentials.smtpUser || credentials.imapUser,
      password: credentials.smtpPassword || credentials.imapPassword,
    },
  }
}
