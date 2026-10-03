/**
 * Message actions (roadmap 2.4): read/unread, flag, archive, delete, move.
 *
 * Optimistic write-through:
 * 1. The change is applied to the local database right away (flags on the
 *    message_location rows, moved/removed locations), so lists and counts
 *    reflect it on the next request.
 * 2. In the same transaction a `message_action` job is enqueued per
 *    (folder, uidvalidity); the worker writes the change back to the IMAP
 *    server (ADR-0003 job table, retries with backoff).
 *
 * The server stays the source of truth: if the write-back fails for good,
 * the next message_sync reconciles the local state to the server again.
 *
 * Moves leave a placeholder location in the target folder (uidvalidity 0,
 * negative uid, see migration 0005) until the real UID is known. Actions on
 * such placeholders are refused with 409 until then (a few seconds).
 *
 * Ownership: folders, messages and target folders are scoped via
 * mail_account.user_id; foreign or unknown ids answer 404.
 */
import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@fma/db'
import { enqueueJob } from '@fma/db/job-queue'
import {
  MAX_MESSAGE_ACTION_BATCH,
  MESSAGE_ACTIONS,
  type MessageAction,
  type MessageActionJobPayload,
  type MessageActionOperation,
  type MessageActionRequest,
  type MessageActionResponse,
} from '@fma/shared'
import { requireAuth } from '../auth/routes'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Flag changes per action: [flag, add?]. */
const FLAG_ACTIONS: Partial<Record<MessageAction, [string, boolean]>> = {
  read: ['\\Seen', true],
  unread: ['\\Seen', false],
  flag: ['\\Flagged', true],
  unflag: ['\\Flagged', false],
}

interface LocationRow {
  id: string
  message_id: string
  uidvalidity: string
  uid: string
}

interface FolderRow {
  id: string
  account_id: string
  special_use: string | null
}

class ActionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

function parseRequest(
  body: Partial<MessageActionRequest> | undefined,
): MessageActionRequest | null {
  if (!body || typeof body !== 'object') return null
  const { folderId, messageIds, action, targetFolderId } = body
  if (typeof folderId !== 'string' || !UUID_RE.test(folderId)) return null
  if (!MESSAGE_ACTIONS.includes(action as MessageAction)) return null
  if (!Array.isArray(messageIds) || messageIds.length === 0) return null
  if (messageIds.length > MAX_MESSAGE_ACTION_BATCH) return null
  if (!messageIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) return null
  if (action === 'move' && (typeof targetFolderId !== 'string' || !UUID_RE.test(targetFolderId))) {
    return null
  }
  return {
    folderId,
    messageIds: [...new Set(messageIds.map((id) => id.toLowerCase()))],
    action: action as MessageAction,
    targetFolderId: action === 'move' ? targetFolderId : undefined,
  }
}

/** Resolves the target folder of a move-like action (null: flag action or permanent delete). */
async function resolveTarget(
  client: PoolClient,
  source: FolderRow,
  request: MessageActionRequest,
): Promise<FolderRow | null> {
  const bySpecialUse = async (specialUse: string): Promise<FolderRow | null> => {
    const { rows } = await client.query<FolderRow>(
      `SELECT id, account_id, special_use FROM folder
       WHERE account_id = $1 AND special_use = $2 ORDER BY path LIMIT 1`,
      [source.account_id, specialUse],
    )
    return rows[0] ?? null
  }

  switch (request.action) {
    case 'archive': {
      if (source.special_use === 'archive') {
        throw new ActionError(400, 'Die Nachricht ist bereits im Archiv.')
      }
      const archive = await bySpecialUse('archive')
      if (!archive) throw new ActionError(409, 'Für dieses Konto gibt es keinen Archiv-Ordner.')
      return archive
    }
    case 'delete': {
      // Inside Trash, delete means permanently (\Deleted + EXPUNGE).
      if (source.special_use === 'trash') return null
      const trash = await bySpecialUse('trash')
      if (!trash) throw new ActionError(409, 'Für dieses Konto gibt es keinen Papierkorb-Ordner.')
      return trash
    }
    case 'move': {
      const { rows } = await client.query<FolderRow>(
        `SELECT id, account_id, special_use FROM folder
         WHERE id = $1 AND account_id = $2 AND selectable`,
        [request.targetFolderId, source.account_id],
      )
      const target = rows[0]
      if (!target) throw new ActionError(404, 'Zielordner nicht gefunden.')
      if (target.id === source.id) {
        throw new ActionError(400, 'Die Nachricht ist bereits in diesem Ordner.')
      }
      return target
    }
    default:
      return null
  }
}

async function applyAction(
  client: PoolClient,
  userId: string,
  request: MessageActionRequest,
): Promise<number> {
  const { rows: folders } = await client.query<FolderRow>(
    `SELECT f.id, f.account_id, f.special_use
     FROM folder f JOIN mail_account a ON a.id = f.account_id
     WHERE f.id = $1 AND a.user_id = $2
     FOR UPDATE OF f`,
    [request.folderId, userId],
  )
  const source = folders[0]
  if (!source) throw new ActionError(404, 'Ordner nicht gefunden.')

  // Lock the affected locations: concurrent actions/syncs on the same rows
  // serialize instead of interleaving.
  const { rows: locations } = await client.query<LocationRow>(
    `SELECT id, message_id::text AS message_id, uidvalidity::text AS uidvalidity, uid::text AS uid
     FROM message_location
     WHERE folder_id = $1 AND message_id = ANY($2::uuid[])
     ORDER BY uid
     FOR UPDATE`,
    [source.id, request.messageIds],
  )
  const found = new Set(locations.map((row) => row.message_id))
  if (request.messageIds.some((id) => !found.has(id))) {
    throw new ActionError(404, 'Nachricht nicht gefunden.')
  }
  if (locations.some((row) => Number(row.uid) <= 0)) {
    throw new ActionError(
      409,
      'Die Nachricht wird gerade noch verschoben. Bitte gleich noch einmal versuchen.',
    )
  }

  const target = await resolveTarget(client, source, request)
  const locationIds = locations.map((row) => row.id)
  const flagChange = FLAG_ACTIONS[request.action]
  let operation: MessageActionOperation

  if (flagChange) {
    const [flag, add] = flagChange
    await client.query(
      add
        ? `UPDATE message_location SET flags = array_append(flags, $2)
           WHERE id = ANY($1::uuid[]) AND NOT ($2 = ANY(flags))`
        : `UPDATE message_location SET flags = array_remove(flags, $2)
           WHERE id = ANY($1::uuid[])`,
      [locationIds, flag],
    )
    operation = request.action as MessageActionOperation
  } else if (target) {
    // Optimistic move: the location becomes a placeholder in the target
    // folder (real UID follows from the write-back job / next sync).
    await client.query(
      `UPDATE message_location
       SET folder_id = $2, uidvalidity = 0, uid = -nextval('message_location_placeholder_seq')
       WHERE id = ANY($1::uuid[])`,
      [locationIds, target.id],
    )
    operation = 'move'
  } else {
    // Permanent delete from Trash: drop the location now; the job expunges
    // on the server and removes messages left without any location.
    await client.query('DELETE FROM message_location WHERE id = ANY($1::uuid[])', [locationIds])
    operation = 'expunge'
  }

  // One write-back job per uidvalidity (normally exactly one).
  const groups = new Map<string, LocationRow[]>()
  for (const row of locations) {
    const group = groups.get(row.uidvalidity) ?? []
    group.push(row)
    groups.set(row.uidvalidity, group)
  }
  for (const [uidvalidity, rows] of groups) {
    const payload: MessageActionJobPayload = {
      operation,
      folderId: source.id,
      uidvalidity,
      items: rows.map((row) => ({
        uid: Number(row.uid),
        locationId: row.id,
        messageId: row.message_id,
      })),
      ...(target ? { targetFolderId: target.id } : {}),
    }
    await enqueueJob(client, {
      type: 'message_action',
      accountId: source.account_id,
      payload: payload as unknown as Record<string, unknown>,
    })
  }
  return locations.length
}

export async function messageActionRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.post<{ Body: Partial<MessageActionRequest> }>(
    '/api/messages/actions',
    { onRequest: requireAuth },
    async (request, reply) => {
      const parsed = parseRequest(request.body)
      if (!parsed) {
        await reply.code(400).send({
          message: `Ungültige Aktion (Ordner, Aktion, 1-${MAX_MESSAGE_ACTION_BATCH} Nachrichten, Zielordner prüfen).`,
        })
        return
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const updated = await applyAction(client, request.auth!.userId, parsed)
        await client.query('COMMIT')
        const body: MessageActionResponse = { updated }
        await reply.send(body)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err instanceof ActionError) {
          await reply.code(err.statusCode).send({ message: err.message })
          return
        }
        throw err
      } finally {
        client.release()
      }
    },
  )
}
