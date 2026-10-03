/**
 * Loads IMAP credentials for an account from the database, decrypting them
 * with the account DEK (envelope encryption, @fma/crypto).
 */
import type { Pool } from '@fma/db'
import { decryptField, loadMasterKey, unwrapDataKey } from '@fma/crypto'
import { isSecurePort } from './ports'

export interface AccountImapCredentials {
  accountId: string
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

export async function loadImapCredentials(
  pool: Pool,
  accountId: string,
  masterKeyBase64: string,
): Promise<AccountImapCredentials> {
  const { rows } = await pool.query<{
    id: string
    imap_host: string
    imap_port: number
    wrapped_dek: Buffer
    key_id: string
    credential_enc: Buffer
  }>(
    `SELECT id, imap_host, imap_port, wrapped_dek, key_id, credential_enc
     FROM mail_account WHERE id = $1`,
    [accountId],
  )
  const row = rows[0]
  if (!row) throw new Error(`account ${accountId} not found`)

  const masterKey = loadMasterKey(masterKeyBase64)
  const { dataKey } = unwrapDataKey(masterKey, row.wrapped_dek.toString('utf8'))
  const credentialsJson = decryptField(
    dataKey,
    row.credential_enc.toString('utf8'),
    `mail_account.credential:${row.id}`,
  )
  const credentials = JSON.parse(credentialsJson) as { imapUser: string; imapPassword: string }

  return {
    accountId: row.id,
    host: row.imap_host,
    port: row.imap_port,
    secure: isSecurePort(row.imap_port),
    user: credentials.imapUser,
    password: credentials.imapPassword,
  }
}
