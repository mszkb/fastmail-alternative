/**
 * Mail read API (roadmap 2.3): folder tree, paginated message lists and
 * message details for the logged-in user's accounts.
 *
 * - Every query is scoped via mail_account.user_id; foreign or unknown ids
 *   answer 404 (no distinction, no existence oracle).
 * - Human-readable fields are decrypted here with the account DEK (unwrapped
 *   per request with the master key). Decrypted values are never logged.
 * - Lists use keyset pagination over (sort date, location id) - stable
 *   while new mail arrives, no OFFSET.
 * - Read-only: opening a message does NOT set \Seen by itself (the client
 *   marks it read via ./message-actions), and only the plain-text body is
 *   returned (HTML rendering follows in 2.9).
 */
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { decryptField, messageFieldAad, unwrapAccountKey, type MessageField } from '@fma/crypto'
import type {
  FolderListResponse,
  FolderSummary,
  MailPerson,
  MessageDetail,
  MessageFlags,
  MessageListItem,
  MessageListResponse,
} from '@fma/shared'
import { requireAuth } from '../auth/routes'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Folder order among siblings: INBOX, special-use folders, then by name. */
const SPECIAL_USE_RANK: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
}

/** Deterministic id the sync generates for messages without Message-ID. */
const FALLBACK_MESSAGE_ID_RE = /^<[0-9a-f]{64}@fma\.local>$/

/** Sort date of a message: Date header, falling back to arrival/insert time. */
const SORT_AT = 'coalesce(m.sent_at, m.received_at, m.created_at)'

interface FolderRow {
  id: string
  path: string
  delimiter: string | null
  special_use: string | null
  unread_count: number
  total: number
}

interface ListRow {
  location_id: string
  id: string
  subject_enc: Buffer
  from_enc: Buffer
  snippet_enc: Buffer
  has_attachments: boolean
  flags: string[]
  sort_at: Date
  sort_key: string
}

interface DetailRow {
  id: string
  account_id: string
  wrapped_dek: Buffer
  subject_enc: Buffer
  from_enc: Buffer
  recipients_enc: Buffer
  message_id_header: string
  references: string[]
  sort_at: Date
  has_attachments: boolean
  text_plain_enc: Buffer | null
  flags: string[]
  folder_ids: string[]
}

/** Decrypts one message field; corrupt ciphertexts degrade to null (logged without content). */
function decrypt(
  log: FastifyBaseLogger,
  dek: Buffer,
  value: Buffer | null,
  field: MessageField,
  messageId: string,
): string | null {
  if (!value) return null
  try {
    return decryptField(dek, value.toString('utf8'), messageFieldAad(field, messageId))
  } catch {
    log.warn({ messageId, field }, 'message field could not be decrypted')
    return null
  }
}

function parseJson(json: string | null): unknown {
  if (!json) return null
  try {
    return JSON.parse(json) as unknown
  } catch {
    return null
  }
}

/** Person lists are stored as JSON `[{ name, address }]` (see message sync). */
function toPeople(value: unknown): MailPerson[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is MailPerson => typeof entry?.address === 'string')
    .map((entry) => ({ name: String(entry.name ?? ''), address: entry.address }))
}

function toFlags(flags: string[]): MessageFlags {
  const set = new Set(flags.map((flag) => flag.toLowerCase()))
  return {
    seen: set.has('\\seen'),
    flagged: set.has('\\flagged'),
    answered: set.has('\\answered'),
  }
}

function folderRank(row: FolderRow): number {
  if (row.path.toUpperCase() === 'INBOX') return 0
  return SPECIAL_USE_RANK[row.special_use ?? ''] ?? 100
}

function splitPath(row: FolderRow): { name: string; parentPath: string | null } {
  const delimiter = row.delimiter
  const index = delimiter ? row.path.lastIndexOf(delimiter) : -1
  if (!delimiter || index <= 0) return { name: row.path, parentPath: null }
  return { name: row.path.slice(index + delimiter.length), parentPath: row.path.slice(0, index) }
}

/**
 * Builds the folder tree from flat IMAP paths and returns it in pre-order
 * (parents before children). Folders whose parent is not selectable/known
 * are treated as top-level.
 */
export function buildFolderTree(rows: FolderRow[]): FolderSummary[] {
  const byPath = new Map(rows.map((row) => [row.path, row]))
  const children = new Map<string | null, FolderRow[]>()
  for (const row of rows) {
    const { parentPath } = splitPath(row)
    const key = parentPath !== null && byPath.has(parentPath) ? parentPath : null
    const siblings = children.get(key) ?? []
    siblings.push(row)
    children.set(key, siblings)
  }

  const result: FolderSummary[] = []
  const visit = (parentPath: string | null, parentId: string | null, depth: number): void => {
    const siblings = (children.get(parentPath) ?? []).sort(
      (a, b) =>
        folderRank(a) - folderRank(b) ||
        splitPath(a).name.localeCompare(splitPath(b).name, undefined, { sensitivity: 'base' }),
    )
    for (const row of siblings) {
      result.push({
        id: row.id,
        name: splitPath(row).name,
        path: row.path,
        delimiter: row.delimiter,
        parentId,
        depth,
        specialUse: row.path.toUpperCase() === 'INBOX' ? 'inbox' : row.special_use,
        unreadCount: row.unread_count,
        total: row.total,
      })
      visit(row.path, row.id, depth + 1)
    }
  }
  visit(null, null, 0)
  return result
}

function encodeCursor(sortKey: string, locationId: string): string {
  return Buffer.from(`${sortKey}|${locationId}`, 'utf8').toString('base64url')
}

/** Returns [sortKey, locationId] or null for malformed cursors. */
function decodeCursor(cursor: string): [string, string] | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const index = decoded.lastIndexOf('|')
  if (index <= 0) return null
  const sortKey = decoded.slice(0, index)
  const locationId = decoded.slice(index + 1)
  // Postgres timestamptz text output (ISO DateStyle), e.g. 2026-10-03 12:00:00.123+00
  if (!/^\d{4}-\d{2}-\d{2}[ T][\d:.]+([+-][\d:]+)?$/.test(sortKey)) return null
  if (!UUID_RE.test(locationId)) return null
  return [sortKey, locationId]
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value === '') return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1) return null
  return Math.min(limit, MAX_LIMIT)
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool
  const masterKey = (): string => process.env.MASTER_KEY ?? ''

  app.get<{ Params: { id: string } }>(
    '/api/accounts/:id/folders',
    { preHandler: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      if (!UUID_RE.test(accountId)) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      const account = await pool.query(
        'SELECT 1 FROM mail_account WHERE id = $1 AND user_id = $2',
        [accountId, request.auth!.userId],
      )
      if (account.rowCount === 0) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }

      // Counts are computed from the synced locations, so they always match
      // what the message list can show.
      const { rows } = await pool.query<FolderRow>(
        `SELECT f.id, f.path, f.delimiter, f.special_use,
                count(ml.id) FILTER (WHERE NOT ('\\Seen' = ANY(ml.flags)))::int AS unread_count,
                count(ml.id)::int AS total
         FROM folder f
         LEFT JOIN message_location ml ON ml.folder_id = f.id
         WHERE f.account_id = $1
         GROUP BY f.id`,
        [accountId],
      )
      const body: FolderListResponse = { folders: buildFolderTree(rows) }
      await reply.send(body)
    },
  )

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/api/folders/:id/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const folderId = request.params.id
      if (!UUID_RE.test(folderId)) {
        await reply.code(404).send({ message: 'Ordner nicht gefunden.' })
        return
      }
      const limit = parseLimit(request.query.limit)
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : undefined
      if (limit === null || cursor === null) {
        await reply.code(400).send({ message: 'Ungültige Parameter (cursor/limit).' })
        return
      }

      const folder = await pool.query<{ account_id: string; wrapped_dek: Buffer }>(
        `SELECT f.account_id, a.wrapped_dek
         FROM folder f JOIN mail_account a ON a.id = f.account_id
         WHERE f.id = $1 AND a.user_id = $2`,
        [folderId, request.auth!.userId],
      )
      const folderRow = folder.rows[0]
      if (!folderRow) {
        await reply.code(404).send({ message: 'Ordner nicht gefunden.' })
        return
      }

      // Keyset pagination: the cursor carries the exact (microsecond) sort
      // key as text plus the location id as tie-breaker.
      const { rows } = await pool.query<ListRow>(
        `SELECT ml.id AS location_id, m.id, m.subject_enc, m.from_enc, m.snippet_enc,
                m.has_attachments, ml.flags,
                ${SORT_AT} AS sort_at, (${SORT_AT})::text AS sort_key
         FROM message_location ml
         JOIN message m ON m.id = ml.message_id
         WHERE ml.folder_id = $1
           AND ($2::timestamptz IS NULL OR (${SORT_AT}, ml.id) < ($2::timestamptz, $3::uuid))
         ORDER BY ${SORT_AT} DESC, ml.id DESC
         LIMIT $4`,
        [folderId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      )

      const dek = unwrapAccountKey(masterKey(), folderRow.wrapped_dek)
      const page = rows.slice(0, limit)
      const messages: MessageListItem[] = page.map((row) => ({
        id: row.id,
        subject: decrypt(request.log, dek, row.subject_enc, 'subject', row.id) ?? '',
        from:
          toPeople(parseJson(decrypt(request.log, dek, row.from_enc, 'from', row.id)))[0] ?? null,
        date: row.sort_at.toISOString(),
        snippet: decrypt(request.log, dek, row.snippet_enc, 'snippet', row.id) ?? '',
        flags: toFlags(row.flags),
        hasAttachments: row.has_attachments,
      }))
      const last = page[page.length - 1]
      const body: MessageListResponse = {
        messages,
        nextCursor:
          rows.length > limit && last ? encodeCursor(last.sort_key, last.location_id) : null,
      }
      await reply.send(body)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/messages/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const messageId = request.params.id
      if (!UUID_RE.test(messageId)) {
        await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
        return
      }
      // Flags: union over all locations of the message (it may live in
      // several folders of the account).
      const { rows } = await pool.query<DetailRow>(
        `SELECT m.id, m.account_id, a.wrapped_dek, m.subject_enc, m.from_enc, m.recipients_enc,
                m.message_id_header, m."references",
                ${SORT_AT} AS sort_at, m.has_attachments, mb.text_plain_enc,
                coalesce((SELECT array_agg(DISTINCT flag) FROM message_location ml,
                            unnest(ml.flags) AS flag WHERE ml.message_id = m.id), '{}') AS flags,
                coalesce((SELECT array_agg(ml.folder_id::text) FROM message_location ml
                          WHERE ml.message_id = m.id), '{}') AS folder_ids
         FROM message m
         JOIN mail_account a ON a.id = m.account_id
         LEFT JOIN message_body mb ON mb.message_id = m.id
         WHERE m.id = $1 AND a.user_id = $2`,
        [messageId, request.auth!.userId],
      )
      const row = rows[0]
      if (!row) {
        await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
        return
      }

      const dek = unwrapAccountKey(masterKey(), row.wrapped_dek)
      const recipients = (parseJson(
        decrypt(request.log, dek, row.recipients_enc, 'recipients', row.id),
      ) ?? {}) as { to?: unknown; cc?: unknown; replyTo?: unknown }
      const body: MessageDetail = {
        id: row.id,
        accountId: row.account_id,
        folderIds: row.folder_ids,
        subject: decrypt(request.log, dek, row.subject_enc, 'subject', row.id) ?? '',
        from:
          toPeople(parseJson(decrypt(request.log, dek, row.from_enc, 'from', row.id)))[0] ?? null,
        to: toPeople(recipients.to),
        cc: toPeople(recipients.cc),
        replyTo: toPeople(recipients.replyTo),
        date: row.sort_at.toISOString(),
        flags: toFlags(row.flags),
        hasAttachments: row.has_attachments,
        // Synthetic ids of messages without a Message-ID are not exposed:
        // a reply must not reference an id no other client knows.
        messageId: FALLBACK_MESSAGE_ID_RE.test(row.message_id_header)
          ? null
          : row.message_id_header,
        references: row.references,
        text: decrypt(request.log, dek, row.text_plain_enc, 'text', row.id),
      }
      await reply.send(body)
    },
  )
}
