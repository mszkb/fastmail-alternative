/**
 * User settings and the optional unified inbox (roadmap 3.7, principle 8).
 *
 * - Accounts stay separate by default: `user.unified_inbox_enabled` is off
 *   until the user switches it on (GET/PUT /api/settings). While it is off,
 *   GET /api/unified/inbox answers 404.
 * - The unified inbox is only a query over the INBOX folders of all accounts
 *   of the user (no own table, no own sync). Each entry carries its
 *   accountId/folderId so the client opens and replies from that account.
 * - Same list columns, decryption and keyset pagination as the folder list
 *   (./messages); every account's DEK is unwrapped at most once per request.
 * - Index use: the planner resolves the user's INBOX folders (few rows) and
 *   reads their locations via message_location_folder_idx, then sorts - the
 *   same plan as a single folder list, so no extra index is needed.
 */
import type { FastifyInstance } from 'fastify'
import { unwrapAccountKey } from '@fma/crypto'
import type { UnifiedMessageListResponse, UserSettings } from '@fma/shared'
import { requireAuth } from '../auth/routes'
import {
  LIST_COLUMNS,
  SORT_AT,
  decodeCursor,
  encodeCursor,
  parseLimit,
  toListItem,
  type ListRow,
} from './messages'

export async function unifiedRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool
  const masterKey = (): string => process.env.MASTER_KEY ?? ''

  async function loadSettings(userId: string): Promise<UserSettings> {
    const { rows } = await pool.query<{ unified_inbox_enabled: boolean }>(
      'SELECT unified_inbox_enabled FROM "user" WHERE id = $1',
      [userId],
    )
    return { unifiedInbox: rows[0]?.unified_inbox_enabled ?? false }
  }

  app.get('/api/settings', { onRequest: requireAuth }, async (request, reply) => {
    await reply.send(await loadSettings(request.auth!.userId))
  })

  app.put<{ Body: { unifiedInbox?: unknown } }>(
    '/api/settings',
    { onRequest: requireAuth },
    async (request, reply) => {
      const value = request.body?.unifiedInbox
      if (typeof value !== 'boolean') {
        await reply.code(400).send({ message: 'Ungültige Einstellungen.' })
        return
      }
      await pool.query('UPDATE "user" SET unified_inbox_enabled = $1 WHERE id = $2', [
        value,
        request.auth!.userId,
      ])
      await reply.send(await loadSettings(request.auth!.userId))
    },
  )

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/api/unified/inbox',
    { onRequest: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId
      if (!(await loadSettings(userId)).unifiedInbox) {
        await reply.code(404).send({ message: 'Gemeinsamer Posteingang ist ausgeschaltet.' })
        return
      }
      const limit = parseLimit(request.query.limit)
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : undefined
      if (limit === null || cursor === null) {
        await reply.code(400).send({ message: 'Ungültige Parameter (cursor/limit).' })
        return
      }

      // INBOX is identified by its IMAP name (RFC 3501: case-insensitive,
      // always present), exactly like the folder tree marks it.
      const { rows } = await pool.query<
        ListRow & { account_id: string; folder_id: string; wrapped_dek: Buffer }
      >(
        `SELECT ${LIST_COLUMNS}, m.account_id, ml.folder_id, a.wrapped_dek
         FROM mail_account a
         JOIN folder f ON f.account_id = a.id AND upper(f.path) = 'INBOX'
         JOIN message_location ml ON ml.folder_id = f.id
         JOIN message m ON m.id = ml.message_id
         WHERE a.user_id = $1
           AND ($2::timestamptz IS NULL OR (${SORT_AT}, ml.id) < ($2::timestamptz, $3::uuid))
         ORDER BY ${SORT_AT} DESC, ml.id DESC
         LIMIT $4`,
        [userId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      )

      const deks = new Map<string, Buffer>()
      const page = rows.slice(0, limit)
      const messages = page.map((row) => {
        let dek = deks.get(row.account_id)
        if (!dek) {
          dek = unwrapAccountKey(masterKey(), row.wrapped_dek)
          deks.set(row.account_id, dek)
        }
        return {
          ...toListItem(request.log, dek, row),
          accountId: row.account_id,
          folderId: row.folder_id,
        }
      })
      const last = page[page.length - 1]
      const body: UnifiedMessageListResponse = {
        messages,
        nextCursor:
          rows.length > limit && last ? encodeCursor(last.sort_key, last.location_id) : null,
      }
      await reply.send(body)
    },
  )
}
