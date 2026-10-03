/**
 * Folder role mapping (roadmap 3.3): `PATCH /api/folders/:id` assigns a
 * role (Sent/Drafts/Trash/Archive/Junk) to a folder manually, or returns it
 * to automatic detection with `specialUse: null`.
 *
 * - The choice is stored in folder.special_use_override, which folder_sync
 *   never overwrites; a role is overridden on at most one folder per
 *   account (assigning it elsewhere moves it).
 * - The effective special_use of all folders of the account is recomputed
 *   right away with the same resolver the worker uses (@fma/shared), so
 *   actions (archive, trash, sent copy) use the new folder immediately.
 * - Ownership via mail_account.user_id; foreign/unknown ids answer 404.
 */
import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient } from '@fma/db'
import { isFolderRole, resolveFolderRoles } from '@fma/shared'
import { requireAuth } from '../auth/routes'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Recomputes folder.special_use of one account from detected roles + overrides. */
export async function applyFolderRoles(
  client: Pool | PoolClient,
  accountId: string,
): Promise<void> {
  const { rows } = await client.query<{
    id: string
    path: string
    special_use: string | null
    special_use_detected: string | null
    special_use_override: string | null
  }>(
    `SELECT id, path, special_use, special_use_detected, special_use_override
     FROM folder WHERE account_id = $1`,
    [accountId],
  )
  const roles = resolveFolderRoles(
    rows.map((row) => ({
      path: row.path,
      detected: row.special_use_detected,
      override: row.special_use_override,
    })),
  )
  for (const row of rows) {
    const role = roles.get(row.path) ?? null
    if (role !== row.special_use) {
      await client.query('UPDATE folder SET special_use = $2 WHERE id = $1', [row.id, role])
    }
  }
}

export async function folderRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/folders/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const input = (request.body ?? {}) as { specialUse?: unknown }
      if (
        !('specialUse' in input) ||
        (input.specialUse !== null && !isFolderRole(input.specialUse))
      ) {
        await reply.code(400).send({ message: 'Ungültige Ordnerrolle.' })
        return
      }
      const role = input.specialUse
      const folderId = request.params.id
      if (!UUID_RE.test(folderId)) {
        await reply.code(404).send({ message: 'Ordner nicht gefunden.' })
        return
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const folder = await client.query<{
          account_id: string
          path: string
          selectable: boolean
        }>(
          `SELECT f.account_id, f.path, f.selectable FROM folder f
           JOIN mail_account a ON a.id = f.account_id
           WHERE f.id = $1 AND a.user_id = $2
           FOR UPDATE OF f`,
          [folderId, request.auth!.userId],
        )
        const row = folder.rows[0]
        if (!row) {
          await client.query('ROLLBACK')
          await reply.code(404).send({ message: 'Ordner nicht gefunden.' })
          return
        }
        if (role && !row.selectable) {
          await client.query('ROLLBACK')
          await reply.code(400).send({ message: 'Dieser Ordner kann keine Nachrichten enthalten.' })
          return
        }
        if (role && row.path.toUpperCase() === 'INBOX') {
          await client.query('ROLLBACK')
          await reply.code(400).send({ message: 'Der Posteingang kann keine andere Rolle haben.' })
          return
        }
        // Serializes concurrent mapping changes of the same account.
        await client.query('SELECT 1 FROM mail_account WHERE id = $1 FOR UPDATE', [row.account_id])
        if (role) {
          await client.query(
            `UPDATE folder SET special_use_override = NULL
             WHERE account_id = $1 AND special_use_override = $2 AND id <> $3`,
            [row.account_id, role, folderId],
          )
        }
        await client.query('UPDATE folder SET special_use_override = $2 WHERE id = $1', [
          folderId,
          role,
        ])
        await applyFolderRoles(client, row.account_id)
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      await reply.code(204).send()
    },
  )
}
