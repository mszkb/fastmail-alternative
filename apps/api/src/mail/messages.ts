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
 *   marks it read via ./message-actions). Details carry the plain-text
 *   body; the sanitized HTML body comes from ./message-html (2.9).
 * - Threads (roadmap 2.5): list items carry threadId + threadCount; a
 *   thread's messages across all folders of the account come from
 *   GET /api/threads/:id (oldest first, newest MAX_THREAD_MESSAGES).
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
  ThreadDetail,
} from '@fma/shared'
import { requireAuth } from '../auth/routes'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
/** Newest messages returned per thread. */
const MAX_THREAD_MESSAGES = 200
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
export const SORT_AT = 'coalesce(m.sent_at, m.received_at, m.created_at)'

interface FolderRow {
  id: string
  path: string
  delimiter: string | null
  special_use: string | null
  special_use_override?: string | null
  selectable?: boolean
  unread_count: number
  total: number
}

export interface ListRow {
  location_id: string
  id: string
  subject_enc: Buffer
  from_enc: Buffer
  snippet_enc: Buffer
  has_attachments: boolean
  flags: string[]
  sort_at: Date
  sort_key: string
  thread_id: string | null
  thread_count: number
}

interface DetailRow {
  id: string
  account_id: string
  thread_id: string | null
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

/**
 * Message details incl. account DEK; callers add the WHERE clause (always
 * scoped by a.user_id). Flags: union over all locations of the message (it
 * may live in several folders of the account).
 */
const DETAIL_SELECT = /* sql */ `
  SELECT m.id, m.account_id, m.thread_id::text AS thread_id, a.wrapped_dek, m.subject_enc,
         m.from_enc, m.recipients_enc, m.message_id_header, m."references",
         ${SORT_AT} AS sort_at, m.has_attachments, mb.text_plain_enc,
         coalesce((SELECT array_agg(DISTINCT flag) FROM message_location ml,
                     unnest(ml.flags) AS flag WHERE ml.message_id = m.id), '{}') AS flags,
         coalesce((SELECT array_agg(ml.folder_id::text) FROM message_location ml
                   WHERE ml.message_id = m.id), '{}') AS folder_ids
  FROM message m
  JOIN mail_account a ON a.id = m.account_id
  LEFT JOIN message_body mb ON mb.message_id = m.id`

/**
 * List columns of a message location (alias `ml`) joined with its message
 * (alias `m`); shared with the search (./search).
 */
export const LIST_COLUMNS = /* sql */ `
  ml.id AS location_id, m.id, m.subject_enc, m.from_enc, m.snippet_enc,
  m.has_attachments, ml.flags,
  ${SORT_AT} AS sort_at, (${SORT_AT})::text AS sort_key,
  m.thread_id::text AS thread_id,
  CASE WHEN m.thread_id IS NULL THEN 1
       ELSE (SELECT count(*)::int FROM message t WHERE t.thread_id = m.thread_id)
  END AS thread_count`

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

function toMessageDetail(log: FastifyBaseLogger, dek: Buffer, row: DetailRow): MessageDetail {
  const recipients = (parseJson(decrypt(log, dek, row.recipients_enc, 'recipients', row.id)) ??
    {}) as { to?: unknown; cc?: unknown; replyTo?: unknown; deliveredTo?: unknown }
  return {
    id: row.id,
    accountId: row.account_id,
    folderIds: row.folder_ids,
    subject: decrypt(log, dek, row.subject_enc, 'subject', row.id) ?? '',
    from: toPeople(parseJson(decrypt(log, dek, row.from_enc, 'from', row.id)))[0] ?? null,
    to: toPeople(recipients.to),
    cc: toPeople(recipients.cc),
    replyTo: toPeople(recipients.replyTo),
    deliveredTo: Array.isArray(recipients.deliveredTo)
      ? recipients.deliveredTo.filter((value): value is string => typeof value === 'string')
      : [],
    date: row.sort_at.toISOString(),
    flags: toFlags(row.flags),
    hasAttachments: row.has_attachments,
    // Synthetic ids of messages without a Message-ID are not exposed:
    // a reply must not reference an id no other client knows.
    messageId: FALLBACK_MESSAGE_ID_RE.test(row.message_id_header) ? null : row.message_id_header,
    references: row.references,
    text: decrypt(log, dek, row.text_plain_enc, 'text', row.id),
    threadId: row.thread_id,
  }
}

/** Decrypted list entry of a ListRow (see LIST_COLUMNS). */
export function toListItem(log: FastifyBaseLogger, dek: Buffer, row: ListRow): MessageListItem {
  return {
    id: row.id,
    subject: decrypt(log, dek, row.subject_enc, 'subject', row.id) ?? '',
    from: toPeople(parseJson(decrypt(log, dek, row.from_enc, 'from', row.id)))[0] ?? null,
    date: row.sort_at.toISOString(),
    snippet: decrypt(log, dek, row.snippet_enc, 'snippet', row.id) ?? '',
    flags: toFlags(row.flags),
    hasAttachments: row.has_attachments,
    threadId: row.thread_id,
    threadCount: row.thread_count,
  }
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
        specialUseOverride: row.special_use_override ?? null,
        selectable: row.selectable ?? true,
        unreadCount: row.unread_count,
        total: row.total,
      })
      visit(row.path, row.id, depth + 1)
    }
  }
  visit(null, null, 0)
  return result
}

export function encodeCursor(sortKey: string, locationId: string): string {
  return Buffer.from(`${sortKey}|${locationId}`, 'utf8').toString('base64url')
}

/** Returns [sortKey, locationId] or null for malformed cursors. */
export function decodeCursor(cursor: string): [string, string] | null {
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

export function parseLimit(value: string | undefined): number | null {
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
    { onRequest: requireAuth },
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
        `SELECT f.id, f.path, f.delimiter, f.special_use, f.special_use_override, f.selectable,
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
    { onRequest: requireAuth },
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
        `SELECT ${LIST_COLUMNS}
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
      const messages: MessageListItem[] = page.map((row) => toListItem(request.log, dek, row))
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
    { onRequest: requireAuth },
    async (request, reply) => {
      const messageId = request.params.id
      if (!UUID_RE.test(messageId)) {
        await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
        return
      }
      const { rows } = await pool.query<DetailRow>(
        `${DETAIL_SELECT} WHERE m.id = $1 AND a.user_id = $2`,
        [messageId, request.auth!.userId],
      )
      const row = rows[0]
      if (!row) {
        await reply.code(404).send({ message: 'Nachricht nicht gefunden.' })
        return
      }

      const dek = unwrapAccountKey(masterKey(), row.wrapped_dek)
      const body: MessageDetail = toMessageDetail(request.log, dek, row)
      await reply.send(body)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/threads/:id',
    { onRequest: requireAuth },
    async (request, reply) => {
      const threadId = request.params.id
      if (!UUID_RE.test(threadId)) {
        await reply.code(404).send({ message: 'Unterhaltung nicht gefunden.' })
        return
      }
      const thread = await pool.query<{ account_id: string; wrapped_dek: Buffer }>(
        `SELECT t.account_id, a.wrapped_dek
         FROM thread t JOIN mail_account a ON a.id = t.account_id
         WHERE t.id = $1 AND a.user_id = $2`,
        [threadId, request.auth!.userId],
      )
      const threadRow = thread.rows[0]
      if (!threadRow) {
        await reply.code(404).send({ message: 'Unterhaltung nicht gefunden.' })
        return
      }

      // Newest MAX_THREAD_MESSAGES, returned oldest first.
      const { rows } = await pool.query<DetailRow>(
        `${DETAIL_SELECT}
         WHERE m.thread_id = $1 AND m.account_id = $2 AND a.user_id = $3
         ORDER BY ${SORT_AT} DESC, m.id DESC
         LIMIT $4`,
        [threadId, threadRow.account_id, request.auth!.userId, MAX_THREAD_MESSAGES],
      )
      const dek = unwrapAccountKey(masterKey(), threadRow.wrapped_dek)
      const messages = rows.reverse().map((row) => toMessageDetail(request.log, dek, row))
      const body: ThreadDetail = {
        id: threadId,
        accountId: threadRow.account_id,
        subject: messages[messages.length - 1]?.subject ?? '',
        messages,
      }
      await reply.send(body)
    },
  )
}
