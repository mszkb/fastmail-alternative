/**
 * Server configuration export/import (roadmap 4.7, docs/operations/migration.md).
 *
 * - `GET /api/export/config` downloads accounts (name, address, IMAP/SMTP
 *   host, port and user name), identities with signatures, manual folder
 *   mappings and settings as versioned JSON. Passwords, OAuth tokens, DEKs
 *   and mail content are NEVER exported; the user names are decrypted from
 *   the credential blob and only they are copied out of it.
 * - `POST /api/import/config` recreates the accounts on this instance in
 *   one transaction: fresh DEK per account, credential blob with the user
 *   names and EMPTY passwords, status `auth_error` with code
 *   CREDENTIALS_REQUIRED - no job runs until the user enters the password
 *   (PATCH /api/accounts/:id with connection test, then folder_sync).
 *   Folder mappings become folder rows with an override; folder_sync keeps
 *   the override and fills in the rest. Accounts whose address already
 *   exists are skipped.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  CONFIG_EXPORT_FORMAT,
  CONFIG_EXPORT_VERSION,
  FOLDER_ROLES,
  MAX_IDENTITIES_PER_ACCOUNT,
  MAX_IDENTITY_NAME_LENGTH,
  MAX_SIGNATURE_LENGTH,
  isFolderRole,
  type ConfigExport,
  type ConfigExportAccount,
  type ConfigExportIdentity,
  type ConfigImportResponse,
} from '@fma/shared'
import {
  decryptField,
  encryptField,
  generateDataKey,
  loadMasterKey,
  unwrapAccountKey,
  wrapDataKey,
} from '@fma/crypto'
import { isAllowedMailPort, type MailProtocol } from '@fma/shared/mail-transport'
import { requireAuth } from '../auth/routes'
import { IDENTITY_IS_DEFAULT } from './identities'

/** Same bound as account creation. */
const MAX_ACCOUNTS = 20
const IMPORT_BODY_LIMIT_BYTES = 2 * 1024 * 1024
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/
const HOST_RE = /^[a-z0-9.-]{1,253}$|^\[[0-9a-f:.]+\]$/i

function credentialAad(accountId: string): string {
  return `mail_account.credential:${accountId}`
}

interface AccountRow {
  id: string
  display_name: string
  email_address: string
  sort_order: number
  credential_kind: string
  sync_since: Date | null
  imap_host: string
  imap_port: number
  smtp_host: string
  smtp_port: number
  wrapped_dek: Buffer
  credential_enc: Buffer
}

/** Reads only the user names from the credential blob; passwords are dropped here. */
function userNames(row: AccountRow): { imapUser: string; smtpUser: string } {
  try {
    const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', row.wrapped_dek)
    const stored = JSON.parse(
      decryptField(dek, row.credential_enc.toString('utf8'), credentialAad(row.id)),
    ) as { imapUser?: unknown; smtpUser?: unknown }
    const imapUser = typeof stored.imapUser === 'string' ? stored.imapUser : ''
    const smtpUser = typeof stored.smtpUser === 'string' && stored.smtpUser ? stored.smtpUser : ''
    return { imapUser, smtpUser: smtpUser || imapUser }
  } catch {
    return { imapUser: '', smtpUser: '' }
  }
}

// ---- import validation ----------------------------------------------------

type Invalid = { error: string }

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : null
}

function port(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : null
}

function parseHost(
  value: unknown,
  protocol: MailProtocol,
  label: string,
): { host: string; port: number; user: string } | Invalid {
  const input = (value ?? {}) as Record<string, unknown>
  const host = str(input.host, 253)?.toLowerCase()
  const parsedPort = port(input.port)
  const user = str(input.user ?? '', 320)
  if (!host || !HOST_RE.test(host) || parsedPort === null || user === null) {
    return { error: `${label}: Host, Port oder Benutzer ungültig.` }
  }
  if (!isAllowedMailPort(protocol, parsedPort)) {
    return { error: `${label}: Port ${parsedPort} ist nicht erlaubt (MAIL_EXTRA_PORTS).` }
  }
  return { host, port: parsedPort, user }
}

function parseIdentity(value: unknown): ConfigExportIdentity | null {
  const input = (value ?? {}) as Record<string, unknown>
  const emailAddress = str(input.emailAddress, 254)?.toLowerCase()
  const name = str(input.name ?? '', MAX_IDENTITY_NAME_LENGTH)
  const signature =
    input.signature === null || input.signature === undefined
      ? null
      : typeof input.signature === 'string' && input.signature.length <= MAX_SIGNATURE_LENGTH
        ? input.signature.replace(/\r\n?/g, '\n').replace(/\s+$/, '') || null
        : undefined
  if (!emailAddress || !EMAIL_RE.test(emailAddress) || name === null || signature === undefined) {
    return null
  }
  return {
    name: name.replace(/[\r\n\t]+/g, ' '),
    emailAddress,
    signature,
    isDefault: input.isDefault === true,
  }
}

function parseAccount(value: unknown, index: number): ConfigExportAccount | Invalid {
  const label = `Konto ${index + 1}`
  const input = (value ?? {}) as Record<string, unknown>
  const emailAddress = str(input.emailAddress, 254)?.toLowerCase()
  if (!emailAddress || !EMAIL_RE.test(emailAddress)) {
    return { error: `${label}: ungültige E-Mail-Adresse.` }
  }
  const imap = parseHost(input.imap, 'imap', `${label} (IMAP)`)
  if ('error' in imap) return imap
  if (!imap.user) return { error: `${label} (IMAP): Benutzername fehlt.` }
  const smtp = parseHost(input.smtp, 'smtp', `${label} (SMTP)`)
  if ('error' in smtp) return smtp

  const rawIdentities = Array.isArray(input.identities) ? input.identities : []
  if (rawIdentities.length > MAX_IDENTITIES_PER_ACCOUNT) {
    return { error: `${label}: zu viele Identitäten.` }
  }
  const identities: ConfigExportIdentity[] = []
  for (const raw of rawIdentities) {
    const identity = parseIdentity(raw)
    if (!identity) return { error: `${label}: ungültige Identität.` }
    if (identities.some((i) => i.emailAddress === identity.emailAddress)) continue
    identities.push(identity)
  }

  const folderRoles: ConfigExportAccount['folderRoles'] = {}
  const rawRoles = (input.folderRoles ?? {}) as Record<string, unknown>
  if (typeof rawRoles !== 'object' || Array.isArray(rawRoles)) {
    return { error: `${label}: ungültige Ordnerzuordnung.` }
  }
  for (const [role, raw] of Object.entries(rawRoles)) {
    const entry = (raw ?? {}) as Record<string, unknown>
    const path = str(entry.path, 1000)
    const delimiter = typeof entry.delimiter === 'string' ? entry.delimiter.slice(0, 4) : null
    if (!isFolderRole(role) || !path || path.toUpperCase() === 'INBOX') {
      return { error: `${label}: ungültige Ordnerzuordnung.` }
    }
    folderRoles[role] = { path, delimiter: delimiter || null }
  }

  const syncSince =
    typeof input.syncSince === 'string' && !Number.isNaN(Date.parse(input.syncSince))
      ? new Date(input.syncSince).toISOString()
      : null
  const sortOrder =
    typeof input.sortOrder === 'number' && Number.isInteger(input.sortOrder)
      ? Math.max(-1_000_000, Math.min(1_000_000, input.sortOrder))
      : 0
  return {
    displayName: (str(input.displayName, 100) || emailAddress).replace(/[\r\n\t]+/g, ' '),
    emailAddress,
    sortOrder,
    credentialKind: input.credentialKind === 'oauth2' ? 'oauth2' : 'password',
    syncSince,
    imap,
    smtp: { ...smtp, user: smtp.user || imap.user },
    identities,
    folderRoles,
  }
}

/** Validates a whole export file; error messages are German, without file content. */
export function parseConfigImport(body: unknown): ConfigExportAccount[] | Invalid {
  const input = (body ?? {}) as Record<string, unknown>
  if (input.format !== CONFIG_EXPORT_FORMAT) {
    return { error: 'Keine Konfigurationsdatei dieser App.' }
  }
  if (
    typeof input.version !== 'number' ||
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    input.version > CONFIG_EXPORT_VERSION
  ) {
    return { error: 'Die Datei stammt aus einer neueren Version und kann nicht importiert werden.' }
  }
  if (!Array.isArray(input.accounts) || input.accounts.length > MAX_ACCOUNTS) {
    return { error: 'Ungültige Kontenliste.' }
  }
  const accounts: ConfigExportAccount[] = []
  for (const [index, raw] of input.accounts.entries()) {
    const account = parseAccount(raw, index)
    if ('error' in account) return account
    accounts.push(account)
  }
  return accounts
}

export async function configTransferRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.get('/api/export/config', { onRequest: requireAuth }, async (request, reply) => {
    const userId = request.auth!.userId
    const { rows: accounts } = await pool.query<AccountRow>(
      `SELECT id, display_name, email_address, sort_order, credential_kind, sync_since,
              imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, credential_enc
       FROM mail_account WHERE user_id = $1
       ORDER BY sort_order, created_at`,
      [userId],
    )
    const { rows: identities } = await pool.query<{
      account_id: string
      name: string
      email_address: string
      signature: string | null
      is_default: boolean
    }>(
      `SELECT i.account_id, i.name, i.email_address, i.signature,
              ${IDENTITY_IS_DEFAULT} AS is_default
       FROM identity i JOIN mail_account a ON a.id = i.account_id
       WHERE a.user_id = $1
       ORDER BY is_default DESC, i.email_address`,
      [userId],
    )
    const { rows: folders } = await pool.query<{
      account_id: string
      path: string
      delimiter: string | null
      special_use_override: string
    }>(
      `SELECT f.account_id, f.path, f.delimiter, f.special_use_override
       FROM folder f JOIN mail_account a ON a.id = f.account_id
       WHERE a.user_id = $1 AND f.special_use_override IS NOT NULL`,
      [userId],
    )

    const body: ConfigExport = {
      format: CONFIG_EXPORT_FORMAT,
      version: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      accounts: accounts.map((row) => {
        const users = userNames(row)
        const folderRoles: ConfigExportAccount['folderRoles'] = {}
        for (const folder of folders) {
          if (folder.account_id !== row.id || !isFolderRole(folder.special_use_override)) continue
          folderRoles[folder.special_use_override] = {
            path: folder.path,
            delimiter: folder.delimiter,
          }
        }
        return {
          displayName: row.display_name,
          emailAddress: row.email_address,
          sortOrder: row.sort_order,
          credentialKind: row.credential_kind === 'oauth2' ? 'oauth2' : 'password',
          syncSince: row.sync_since ? row.sync_since.toISOString() : null,
          imap: { host: row.imap_host, port: row.imap_port, user: users.imapUser },
          smtp: { host: row.smtp_host, port: row.smtp_port, user: users.smtpUser },
          identities: identities
            .filter((identity) => identity.account_id === row.id)
            .map((identity) => ({
              name: identity.name,
              emailAddress: identity.email_address,
              signature: identity.signature,
              isDefault: identity.is_default,
            })),
          folderRoles,
        }
      }),
      settings: {},
    }
    const date = body.exportedAt.slice(0, 10)
    await reply
      .header('content-disposition', `attachment; filename="fma-config-${date}.json"`)
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(body, null, 2))
  })

  app.post<{ Body: unknown }>(
    '/api/import/config',
    { onRequest: requireAuth, bodyLimit: IMPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = parseConfigImport(request.body)
      if ('error' in parsed) {
        await reply.code(400).send({ message: parsed.error })
        return
      }
      const userId = request.auth!.userId
      const masterKey = loadMasterKey(process.env.MASTER_KEY ?? '')
      const keyId = process.env.MASTER_KEY_ID ?? 'v1'
      const result: ConfigImportResponse = { imported: [], skipped: [] }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Serializes concurrent imports of the same user (account limit).
        await client.query('SELECT 1 FROM "user" WHERE id = $1 FOR UPDATE', [userId])
        const existing = await client.query<{ email_address: string }>(
          'SELECT lower(email_address) AS email_address FROM mail_account WHERE user_id = $1',
          [userId],
        )
        const known = new Set(existing.rows.map((row) => row.email_address))
        let count = known.size

        for (const account of parsed) {
          if (known.has(account.emailAddress)) {
            result.skipped.push(account.emailAddress)
            continue
          }
          if (count >= MAX_ACCOUNTS) {
            await client.query('ROLLBACK')
            await reply.code(409).send({ message: 'Maximale Anzahl an Konten erreicht.' })
            return
          }
          known.add(account.emailAddress)
          count += 1

          const accountId = randomUUID()
          const dek = generateDataKey()
          // Only the user names survive the move; passwords must be re-entered.
          const credentialEnc = Buffer.from(
            encryptField(
              dek,
              JSON.stringify({
                imapUser: account.imap.user,
                imapPassword: '',
                smtpUser: account.smtp.user,
                smtpPassword: '',
              }),
              credentialAad(accountId),
            ),
            'utf8',
          )
          await client.query(
            `INSERT INTO mail_account
               (id, user_id, display_name, email_address, sort_order, imap_host, imap_port,
                smtp_host, smtp_port, wrapped_dek, key_id, credential_kind, sync_since,
                credential_enc, status, last_error_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                     'auth_error', 'CREDENTIALS_REQUIRED')`,
            [
              accountId,
              userId,
              account.displayName,
              account.emailAddress,
              account.sortOrder,
              account.imap.host,
              account.imap.port,
              account.smtp.host,
              account.smtp.port,
              Buffer.from(wrapDataKey(masterKey, dek, keyId), 'utf8'),
              keyId,
              account.credentialKind,
              account.syncSince,
              credentialEnc,
            ],
          )

          // The account address always has an identity (data model).
          const identities = [...account.identities]
          if (!identities.some((i) => i.emailAddress === account.emailAddress)) {
            identities.unshift({
              name: account.displayName,
              emailAddress: account.emailAddress,
              signature: null,
              isDefault: !identities.some((i) => i.isDefault),
            })
          }
          let defaultId: string | null = null
          for (const identity of identities) {
            const { rows } = await client.query<{ id: string }>(
              `INSERT INTO identity (account_id, name, email_address, signature)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [accountId, identity.name, identity.emailAddress, identity.signature],
            )
            if (identity.isDefault && !defaultId) defaultId = rows[0]!.id
          }
          if (defaultId) {
            await client.query('UPDATE mail_account SET default_identity_id = $2 WHERE id = $1', [
              accountId,
              defaultId,
            ])
          }

          for (const role of FOLDER_ROLES) {
            const folder = account.folderRoles[role]
            if (!folder) continue
            await client.query(
              `INSERT INTO folder (account_id, path, delimiter, special_use, special_use_override)
               VALUES ($1, $2, $3, $4, $4)
               ON CONFLICT (account_id, path) DO NOTHING`,
              [accountId, folder.path, folder.delimiter, role],
            )
          }
          result.imported.push(account.emailAddress)
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      request.log.info(
        { imported: result.imported.length, skipped: result.skipped.length },
        'configuration imported',
      )
      await reply.send(result)
    },
  )
}
