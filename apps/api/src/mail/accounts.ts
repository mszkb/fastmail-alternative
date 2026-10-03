/**
 * Mail account management (roadmap 2.1, 3.1): create with connection test,
 * list, edit, delete (crypto-shredding via DEK removal plus volume cleanup).
 *
 * Security rules from the data model:
 * - IMAP/SMTP credentials are encrypted with the account DEK and never
 *   appear in API responses - list/detail use explicit column selects.
 * - The DEK is wrapped with the instance master key (MASTER_KEY env);
 *   `key_id` records the master key version for later rotation.
 * - Deleting an account deletes its DEK: remaining ciphertexts (e.g. in
 *   backups) become unreadable. All account rows (folders, messages,
 *   locations, bodies, threads, outbox, jobs, identities) go with it via
 *   ON DELETE CASCADE; the encrypted files in the mail-data volume are
 *   removed by the worker (`account_cleanup` job), because the api only
 *   mounts the volume read-only.
 * - Editing connection data re-runs the connection test before anything is
 *   saved; credentials stay encrypted with the same DEK and are never sent
 *   back to the client (empty user/password fields mean "unchanged").
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { enqueueJob } from '@fma/db/job-queue'
import type {
  AccountErrorCode,
  AccountListResponse,
  AccountStatus,
  AccountSummary,
} from '@fma/shared'
import {
  decryptField,
  encryptField,
  generateDataKey,
  loadMasterKey,
  unwrapAccountKey,
  wrapDataKey,
} from '@fma/crypto'
import { requireAuth } from '../auth/routes'
import { testImap, testSmtp, type HostConfig, type TestResult } from '../mail/connection-test'

interface MailAccountRow {
  id: string
  display_name: string
  email_address: string
  imap_host: string
  imap_port: number
  smtp_host: string
  smtp_port: number
  status: AccountStatus
  last_error_code: AccountErrorCode | null
  next_retry_at: Date | null
  capabilities: string[]
  sort_order: number
  last_sync_at: string | null
  /** Only selected by the list query. */
  unread_count?: number
}

interface CreateAccountBody {
  displayName?: string
  emailAddress?: string
  imap?: { host?: string; port?: number; user?: string; password?: string }
  smtp?: { host?: string; port?: number; user?: string; password?: string }
}

interface ParsedAccount {
  displayName: string
  emailAddress: string
  imap: HostConfig
  smtp: HostConfig
}

interface UpdateAccountBody {
  displayName?: unknown
  sortOrder?: unknown
  imap?: { host?: unknown; port?: unknown; user?: unknown; password?: unknown }
  smtp?: { host?: unknown; port?: unknown; user?: unknown; password?: unknown }
}

/** Decrypted credential blob (`mail_account.credential_enc`). */
interface StoredCredentials {
  imapUser: string
  imapPassword: string
  smtpUser?: string
  smtpPassword?: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Explicit column select: credential_enc and wrapped_dek must never leak. */
const PUBLIC_COLUMNS = `id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port,
  status, last_error_code, next_retry_at, capabilities, sort_order, last_sync_at`

function credentialAad(accountId: string): string {
  return `mail_account.credential:${accountId}`
}

function encryptCredentials(dek: Buffer, accountId: string, creds: StoredCredentials): Buffer {
  return Buffer.from(encryptField(dek, JSON.stringify(creds), credentialAad(accountId)), 'utf8')
}

function isSecurePort(port: number): boolean {
  return port === 993 || port === 465
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}

function parseCreateBody(body: CreateAccountBody | undefined): ParsedAccount | null {
  const emailAddress = body?.emailAddress?.trim().toLowerCase() ?? ''
  if (!EMAIL_RE.test(emailAddress)) return null
  const imap = body?.imap
  const smtp = body?.smtp
  if (!imap?.host || !imap.user || !imap.password) return null
  if (!smtp?.host) return null
  if (!isValidPort(imap.port) || !isValidPort(smtp.port)) return null

  return {
    displayName: body?.displayName?.trim().slice(0, 100) || emailAddress,
    emailAddress,
    imap: {
      host: imap.host.trim().toLowerCase().slice(0, 253),
      port: imap.port,
      secure: isSecurePort(imap.port),
      user: imap.user.trim().slice(0, 320),
      password: imap.password,
    },
    smtp: {
      host: smtp.host.trim().toLowerCase().slice(0, 253),
      port: smtp.port,
      secure: isSecurePort(smtp.port),
      // Empty strings count as "not provided" -> fall back to IMAP credentials.
      user: (smtp.user?.trim() || imap.user).trim().slice(0, 320),
      password: smtp.password || imap.password,
    },
  }
}

/** Public account shape: never includes credentials or the DEK. */
function toPublicAccount(row: MailAccountRow): AccountSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    emailAddress: row.email_address,
    imap: { host: row.imap_host, port: row.imap_port },
    smtp: { host: row.smtp_host, port: row.smtp_port },
    status: row.status,
    lastErrorCode: row.last_error_code,
    nextRetryAt: row.next_retry_at ? row.next_retry_at.toISOString() : null,
    capabilities: row.capabilities,
    sortOrder: row.sort_order,
    lastSyncAt: row.last_sync_at,
    unreadCount: row.unread_count ?? 0,
  }
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.post<{ Body: CreateAccountBody }>(
    '/api/accounts',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = parseCreateBody(request.body)
      if (!parsed) {
        await reply.code(400).send({
          message: 'Ungültige Kontodaten (E-Mail, Host, Port, Benutzer, Passwort prüfen).',
        })
        return
      }

      const userId = request.auth!.userId

      // Sane upper bound of accounts per user.
      const { rows: countRows } = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM mail_account WHERE user_id = $1',
        [userId],
      )
      if ((countRows[0]?.count ?? 0) >= 20) {
        await reply.code(409).send({ message: 'Maximale Anzahl an Konten erreicht.' })
        return
      }

      // Connection test FIRST: broken accounts are not persisted.
      const imapResult = await testImap(parsed.imap)
      if (!imapResult.ok) {
        await reply.code(422).send({ stage: 'imap', test: imapResult })
        return
      }
      const smtpResult = await testSmtp(parsed.smtp)
      if (!smtpResult.ok) {
        await reply.code(422).send({ stage: 'smtp', test: smtpResult })
        return
      }

      // Envelope encryption: fresh DEK per account, wrapped with the master
      // key. The account id is generated client-side so the credential AAD
      // can reference it from the start (single insert).
      const masterKey = loadMasterKey(process.env.MASTER_KEY ?? '')
      const keyId = process.env.MASTER_KEY_ID ?? 'v1'
      const accountId = randomUUID()
      const dek = generateDataKey()
      const wrappedDek = wrapDataKey(masterKey, dek, keyId)
      const credentialEnc = encryptCredentials(dek, accountId, {
        imapUser: parsed.imap.user,
        imapPassword: parsed.imap.password,
        smtpUser: parsed.smtp.user,
        smtpPassword: parsed.smtp.password,
      })

      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO mail_account
           (id, user_id, display_name, email_address, imap_host, imap_port,
            smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status, capabilities)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ok', $12)
         RETURNING id`,
        [
          accountId,
          userId,
          parsed.displayName,
          parsed.emailAddress,
          parsed.imap.host,
          parsed.imap.port,
          parsed.smtp.host,
          parsed.smtp.port,
          Buffer.from(wrappedDek, 'utf8'),
          keyId,
          credentialEnc,
          imapResult.capabilities ?? [],
        ],
      )
      if (!inserted.rows[0]) throw new Error('account insert returned no id')

      // Default identity from the account email address (data model).
      await pool.query(
        `INSERT INTO identity (account_id, name, email_address) VALUES ($1, $2, $3)`,
        [accountId, parsed.displayName, parsed.emailAddress],
      )

      // Kick off the initial folder sync in the worker (roadmap 2.2).
      await enqueueJob(pool, { type: 'folder_sync', accountId })

      const account = await pool.query<MailAccountRow>(
        `SELECT ${PUBLIC_COLUMNS} FROM mail_account WHERE id = $1`,
        [accountId],
      )
      await reply.code(201).send({
        account: toPublicAccount(account.rows[0]!),
        test: { imap: imapResult, smtp: smtpResult },
      })
    },
  )

  app.get('/api/accounts', { preHandler: requireAuth }, async (request, reply) => {
    // Unread count per account: INBOX only, computed from the synced
    // locations like the folder counts (optimistic read/unread included).
    const { rows } = await pool.query<MailAccountRow>(
      `SELECT ${PUBLIC_COLUMNS},
         (SELECT count(*)::int FROM folder f
          JOIN message_location ml ON ml.folder_id = f.id
          WHERE f.account_id = mail_account.id AND f.special_use = 'inbox'
            AND NOT ('\\Seen' = ANY(ml.flags))) AS unread_count
       FROM mail_account WHERE user_id = $1
       ORDER BY sort_order, created_at`,
      [request.auth!.userId],
    )
    const body: AccountListResponse = { accounts: rows.map(toPublicAccount) }
    await reply.send(body)
  })

  app.patch<{ Params: { id: string }; Body: UpdateAccountBody }>(
    '/api/accounts/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      if (!UUID_RE.test(accountId)) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      const update = parseUpdateBody(request.body)
      if (!update) {
        await reply.code(400).send({
          message: 'Ungültige Kontodaten (Name, Host, Port, Benutzer, Passwort prüfen).',
        })
        return
      }

      const { rows } = await pool.query<{
        imap_host: string
        imap_port: number
        smtp_host: string
        smtp_port: number
        wrapped_dek: Buffer
        credential_enc: Buffer
      }>(
        `SELECT imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, credential_enc
         FROM mail_account WHERE id = $1 AND user_id = $2`,
        [accountId, request.auth!.userId],
      )
      const current = rows[0]
      if (!current) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }

      const sets: string[] = []
      const values: unknown[] = [accountId]
      const set = (column: string, value: unknown): void => {
        values.push(value)
        sets.push(`${column} = $${values.length}`)
      }
      if (update.displayName !== undefined) set('display_name', update.displayName)
      if (update.sortOrder !== undefined) set('sort_order', update.sortOrder)

      let test: { imap: TestResult; smtp: TestResult } | undefined
      if (update.imap || update.smtp) {
        const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', current.wrapped_dek)
        const stored = JSON.parse(
          decryptField(dek, current.credential_enc.toString('utf8'), credentialAad(accountId)),
        ) as StoredCredentials
        const merged = mergeConnection(current, stored, update)

        // Connection test FIRST: nothing is saved when the new data fails.
        const imapResult = await testImap(merged.imap)
        if (!imapResult.ok) {
          await reply.code(422).send({ stage: 'imap', test: imapResult })
          return
        }
        const smtpResult = await testSmtp(merged.smtp)
        if (!smtpResult.ok) {
          await reply.code(422).send({ stage: 'smtp', test: smtpResult })
          return
        }
        test = { imap: imapResult, smtp: smtpResult }

        set('imap_host', merged.imap.host)
        set('imap_port', merged.imap.port)
        set('smtp_host', merged.smtp.host)
        set('smtp_port', merged.smtp.port)
        set(
          'credential_enc',
          encryptCredentials(dek, accountId, {
            imapUser: merged.imap.user,
            imapPassword: merged.imap.password,
            smtpUser: merged.smtp.user,
            smtpPassword: merged.smtp.password,
          }),
        )
        set('capabilities', imapResult.capabilities ?? [])
        // Working credentials: clear the error state (roadmap 3.4).
        sets.push(
          `status = 'ok'`,
          'error_count = 0',
          'next_retry_at = NULL',
          'last_error_code = NULL',
        )
      }

      if (sets.length > 0) {
        await pool.query(`UPDATE mail_account SET ${sets.join(', ')} WHERE id = $1`, values)
      }
      // Re-sync right away with the new connection data.
      if (test) await enqueueJob(pool, { type: 'folder_sync', accountId })

      const account = await pool.query<MailAccountRow>(
        `SELECT ${PUBLIC_COLUMNS} FROM mail_account WHERE id = $1`,
        [accountId],
      )
      await reply.send({ account: toPublicAccount(account.rows[0]!), ...(test ? { test } : {}) })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/accounts/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      if (!UUID_RE.test(accountId)) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Cascades to identities, folders, messages, locations, bodies,
        // threads, outbox and jobs of the account.
        const result = await client.query(
          'DELETE FROM mail_account WHERE id = $1 AND user_id = $2',
          [accountId, request.auth!.userId],
        )
        if (result.rowCount === 0) {
          await client.query('ROLLBACK')
          await reply.code(404).send({ message: 'Konto nicht gefunden.' })
          return
        }
        // The encrypted files in the mail-data volume are removed by the
        // worker. The job carries the id in its payload only: job.account_id
        // would cascade-delete the job together with the account.
        await enqueueJob(client, { type: 'account_cleanup', payload: { accountId } })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      // Crypto-shredding: the wrapped DEK row is gone, orphaned ciphertexts
      // (e.g. in backups) stay unreadable.
      await reply.code(204).send()
    },
  )
}

interface ParsedUpdate {
  displayName?: string
  sortOrder?: number
  imap?: { host?: string; port?: number; user?: string; password?: string }
  smtp?: { host?: string; port?: number; user?: string; password?: string }
}

/**
 * Validates a PATCH body. Every field is optional; empty user/password
 * strings mean "unchanged" (the client never sees stored credentials).
 * Returns null for invalid input.
 */
function parseUpdateBody(body: UpdateAccountBody | undefined): ParsedUpdate | null {
  if (!body || typeof body !== 'object') return null
  const result: ParsedUpdate = {}
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== 'string') return null
    const name = body.displayName.trim().slice(0, 100)
    if (!name) return null
    result.displayName = name
  }
  if (body.sortOrder !== undefined) {
    const order = body.sortOrder
    if (typeof order !== 'number' || !Number.isInteger(order) || Math.abs(order) > 1_000_000) {
      return null
    }
    result.sortOrder = order
  }
  for (const stage of ['imap', 'smtp'] as const) {
    const input = body[stage]
    if (input === undefined) continue
    if (!input || typeof input !== 'object') return null
    const parsed: NonNullable<ParsedUpdate['imap']> = {}
    if (input.host !== undefined) {
      if (typeof input.host !== 'string' || !input.host.trim()) return null
      parsed.host = input.host.trim().toLowerCase().slice(0, 253)
    }
    if (input.port !== undefined) {
      if (!isValidPort(input.port)) return null
      parsed.port = input.port
    }
    if (input.user !== undefined && input.user !== null) {
      if (typeof input.user !== 'string') return null
      if (input.user.trim()) parsed.user = input.user.trim().slice(0, 320)
    }
    if (input.password !== undefined && input.password !== null) {
      if (typeof input.password !== 'string') return null
      if (input.password) parsed.password = input.password
    }
    if (Object.keys(parsed).length > 0) result[stage] = parsed
  }
  return result
}

/**
 * Merges the stored connection data with an update. SMTP credentials that
 * were identical to the IMAP ones follow IMAP changes (the common "password
 * changed at the provider" case) unless SMTP credentials are given
 * explicitly.
 */
function mergeConnection(
  current: { imap_host: string; imap_port: number; smtp_host: string; smtp_port: number },
  stored: StoredCredentials,
  update: ParsedUpdate,
): { imap: HostConfig; smtp: HostConfig } {
  const storedSmtpUser = stored.smtpUser || stored.imapUser
  const storedSmtpPassword = stored.smtpPassword || stored.imapPassword
  const smtpFollowsImap =
    storedSmtpUser === stored.imapUser && storedSmtpPassword === stored.imapPassword

  const imapPort = update.imap?.port ?? current.imap_port
  const imapUser = update.imap?.user ?? stored.imapUser
  const imapPassword = update.imap?.password ?? stored.imapPassword
  const smtpPort = update.smtp?.port ?? current.smtp_port
  return {
    imap: {
      host: update.imap?.host ?? current.imap_host,
      port: imapPort,
      secure: isSecurePort(imapPort),
      user: imapUser,
      password: imapPassword,
    },
    smtp: {
      host: update.smtp?.host ?? current.smtp_host,
      port: smtpPort,
      secure: isSecurePort(smtpPort),
      user: update.smtp?.user ?? (smtpFollowsImap ? imapUser : storedSmtpUser),
      password: update.smtp?.password ?? (smtpFollowsImap ? imapPassword : storedSmtpPassword),
    },
  }
}
