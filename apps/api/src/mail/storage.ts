/**
 * Storage usage per account (roadmap 5.4, #54/#41).
 *
 * - GET /api/accounts/:id/storage: one own account (404 otherwise).
 * - GET /api/storage: all accounts of the user plus the total.
 *
 * Summed from database columns only (no file system scan of the mail-data
 * volume): `message.size_bytes` (provider RFC822.SIZE) of messages with a
 * stored raw body, and `attachment_upload.size_bytes`. The size of the
 * encrypted file itself is not recorded, so `messageBytes` is approximate.
 * Uses the existing indexes on message (account_id, ...), the message_body
 * primary key and attachment_upload (account_id, ...). Numbers only.
 */
import type { FastifyInstance } from 'fastify'
import type { Pool } from '@fma/db'
import type { AccountStorage, StorageResponse } from '@fma/shared'
import { requireAuth } from '../auth/routes'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface StorageRow {
  id: string
  message_count: number
  stored_message_count: number
  message_bytes: number
  upload_count: number
  upload_bytes: number
}

/** Storage usage of the user's accounts (or one of them); empty: no such account. */
export async function accountStorage(
  pool: Pool,
  userId: string,
  accountId: string | null,
): Promise<AccountStorage[]> {
  const { rows } = await pool.query<StorageRow>(
    `WITH acc AS (
       SELECT id, sort_order, created_at FROM mail_account
       WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
     ), msg AS (
       -- One pass over the user's messages (grouped), not one per account.
       SELECT m.account_id,
         count(*)::float8 AS message_count,
         count(b.message_id)::float8 AS stored_message_count,
         coalesce(sum(m.size_bytes) FILTER (WHERE b.message_id IS NOT NULL), 0)::float8
           AS message_bytes
       FROM message m
       LEFT JOIN message_body b ON b.message_id = m.id AND b.storage_ref IS NOT NULL
       WHERE m.account_id IN (SELECT id FROM acc)
       GROUP BY m.account_id
     ), up AS (
       SELECT u.account_id, count(*)::float8 AS upload_count,
         coalesce(sum(u.size_bytes), 0)::float8 AS upload_bytes
       FROM attachment_upload u
       WHERE u.account_id IN (SELECT id FROM acc)
       GROUP BY u.account_id
     )
     SELECT acc.id::text AS id,
       coalesce(msg.message_count, 0) AS message_count,
       coalesce(msg.stored_message_count, 0) AS stored_message_count,
       coalesce(msg.message_bytes, 0) AS message_bytes,
       coalesce(up.upload_count, 0) AS upload_count,
       coalesce(up.upload_bytes, 0) AS upload_bytes
     FROM acc
     LEFT JOIN msg ON msg.account_id = acc.id
     LEFT JOIN up ON up.account_id = acc.id
     ORDER BY acc.sort_order, acc.created_at`,
    [userId, accountId],
  )
  return rows.map((row) => ({
    accountId: row.id,
    messageCount: row.message_count,
    storedMessageCount: row.stored_message_count,
    messageBytes: row.message_bytes,
    uploadCount: row.upload_count,
    uploadBytes: row.upload_bytes,
    totalBytes: row.message_bytes + row.upload_bytes,
  }))
}

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.get('/api/storage', { onRequest: requireAuth }, async (request, reply) => {
    const accounts = await accountStorage(pool, request.auth!.userId, null)
    const body: StorageResponse = {
      accounts,
      totalBytes: accounts.reduce((sum, a) => sum + a.totalBytes, 0),
    }
    await reply.send(body)
  })

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id/storage',
    { onRequest: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      const [result] = UUID_RE.test(accountId)
        ? await accountStorage(pool, request.auth!.userId, accountId)
        : []
      if (!result) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      await reply.send(result)
    },
  )
}
