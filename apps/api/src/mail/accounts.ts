/**
 * Mail account management (roadmap 2.1): create with connection test,
 * list, delete (crypto-shredding via DEK removal).
 *
 * Security rules from the data model:
 * - IMAP/SMTP credentials are encrypted with the account DEK and never
 *   appear in API responses - list/detail use explicit column selects.
 * - The DEK is wrapped with the instance master key (MASTER_KEY env);
 *   `key_id` records the master key version for later rotation.
 * - Deleting an account deletes its DEK: remaining ciphertexts (e.g. in
 *   backups) become unreadable.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import { requireAuth } from '../auth/routes'
import { testImap, testSmtp, type HostConfig } from '../mail/connection-test'

interface MailAccountRow {
  id: string
  display_name: string
  email_address: string
  imap_host: string
  imap_port: number
  smtp_host: string
  smtp_port: number
  status: string
  capabilities: string[]
  sort_order: number
  last_sync_at: string | null
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isSecurePort(port: number): boolean {
  return port === 993 || port === 465
}

function isValidPort(port: number | undefined): port is number {
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
function toPublicAccount(row: MailAccountRow): Record<string, unknown> {
  return {
    id: row.id,
    displayName: row.display_name,
    emailAddress: row.email_address,
    imap: { host: row.imap_host, port: row.imap_port },
    smtp: { host: row.smtp_host, port: row.smtp_port },
    status: row.status,
    capabilities: row.capabilities,
    sortOrder: row.sort_order,
    lastSyncAt: row.last_sync_at,
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
      const credentialEnc = Buffer.from(
        encryptField(
          dek,
          JSON.stringify({
            imapUser: parsed.imap.user,
            imapPassword: parsed.imap.password,
            smtpUser: parsed.smtp.user,
            smtpPassword: parsed.smtp.password,
          }),
          `mail_account.credential:${accountId}`,
        ),
        'utf8',
      )

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

      const account = await pool.query<MailAccountRow>(
        `SELECT id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port,
                status, capabilities, sort_order, last_sync_at
         FROM mail_account WHERE id = $1`,
        [accountId],
      )
      await reply.code(201).send({
        account: toPublicAccount(account.rows[0]!),
        test: { imap: imapResult, smtp: smtpResult },
      })
    },
  )

  app.get('/api/accounts', { preHandler: requireAuth }, async (request, reply) => {
    // Explicit column select: credential_enc and wrapped_dek must never leak.
    const { rows } = await pool.query<MailAccountRow>(
      `SELECT id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port,
              status, capabilities, sort_order, last_sync_at
       FROM mail_account WHERE user_id = $1
       ORDER BY sort_order, created_at`,
      [request.auth!.userId],
    )
    await reply.send({ accounts: rows.map(toPublicAccount) })
  })

  app.delete<{ Params: { id: string } }>(
    '/api/accounts/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = await pool.query('DELETE FROM mail_account WHERE id = $1 AND user_id = $2', [
        request.params.id,
        request.auth!.userId,
      ])
      if (result.rowCount === 0) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      // Crypto-shredding: the wrapped DEK row is gone, orphaned ciphertexts
      // (e.g. in backups) stay unreadable. Volume cleanup follows in 5.5.
      await reply.code(204).send()
    },
  )
}
