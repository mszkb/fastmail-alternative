/**
 * Search (roadmap 5.1, ADR-0006): `GET /api/accounts/:id/search` runs IMAP
 * SEARCH at the provider and maps the matching UIDs back to locally synced
 * messages. There is no search index and nothing of the query or the
 * results is persisted.
 *
 * - The api talks to the provider itself, with one short-lived connection
 *   per search (the documented exception in overview.md - a worker job with
 *   result polling would add latency and state for no gain). Guarded like
 *   every provider connection: SSRF check of the host (assertPublicHost),
 *   connect/greeting/socket timeouts and an overall deadline after which
 *   the connection is closed. Accounts with an auth error or disabled are
 *   not contacted.
 * - Folders: the given one, or INBOX and the other selectable folders
 *   except Junk/Trash (at most MAX_FOLDERS, INBOX and special-use folders
 *   first).
 * - Mapping: UIDs are looked up in message_location with the folder's
 *   current UIDVALIDITY; matches without a local copy are only counted
 *   (`notSynced`, "weitere Treffer beim Anbieter").
 * - Privacy: the query is never logged (request URLs are logged without
 *   query string, see ../logging) and never stored. The provider's UIDs
 *   per search are cached in memory for CACHE_TTL_MS under a salted hash of
 *   the query, so paging back and forth does not hit the provider again;
 *   flags and contents are always read fresh from the database.
 * - Rate limit: RATE_LIMIT provider searches per account and minute (cache
 *   hits do not count); more answer 429.
 */
import { createHash, randomBytes } from 'node:crypto'
import { ImapFlow, type SearchObject } from 'imapflow'
import type { FastifyInstance } from 'fastify'
import type { Pool } from '@fma/db'
import { decryptField, unwrapAccountKey } from '@fma/crypto'
import {
  SEARCH_LIMITS,
  parseSearchQuery,
  type SearchQuery,
  type SearchResponse,
  type SearchResultItem,
} from '@fma/shared'
import {
  imapTransportOptions,
  isSecurePort,
  isStartTlsUnavailable,
} from '@fma/shared/mail-transport'
import { requireAuth } from '../auth/routes'
import { LIST_COLUMNS, toListItem, type ListRow } from './messages'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_FOLDERS = 20
/** UIDs per folder that are mapped to local messages (newest first). */
const MAX_MAPPED_UIDS = 5000
const CONNECT_TIMEOUT_MS = 10_000
const SOCKET_TIMEOUT_MS = 30_000
/** Overall deadline of one search; the connection is closed afterwards. */
const SEARCH_DEADLINE_MS = 30_000
export const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 100

/** Folder order of the default scope (lower first). */
const FOLDER_RANK: Record<string, number> = { inbox: 0, sent: 1, archive: 2, drafts: 3 }

interface FolderHits {
  folderId: string
  uidvalidity: string
  /** Matching UIDs, newest (highest) first. */
  uids: number[]
}

interface ProviderResult {
  folders: FolderHits[]
  foldersFailed: number
}

/** Error with a stable code (no provider text: it may echo the query). */
class SearchError extends Error {
  constructor(
    readonly code: 'AUTH_FAILED' | 'BLOCKED_HOST' | 'TIMEOUT' | 'TLS_REQUIRED' | 'UNREACHABLE',
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

// --- in-memory rate limit and result cache --------------------------------

const searchesPerAccount = new Map<string, number[]>()
const cache = new Map<string, { expires: number; result: ProviderResult }>()
/** Per-process salt: cache keys are not a dictionary of queries. */
const cacheSalt = randomBytes(32)

/** Records a provider search; false when the account exceeded the limit. */
function takeRateLimit(accountId: string, now = Date.now()): boolean {
  const recent = (searchesPerAccount.get(accountId) ?? []).filter((t) => t > now - RATE_WINDOW_MS)
  if (recent.length >= RATE_LIMIT) {
    searchesPerAccount.set(accountId, recent)
    return false
  }
  recent.push(now)
  searchesPerAccount.set(accountId, recent)
  return true
}

/** Forgets rate limits and cached results (tests). */
export function resetSearchState(): void {
  searchesPerAccount.clear()
  cache.clear()
}

function cacheKey(accountId: string, query: SearchQuery): string {
  const ordered = Object.entries(query).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256')
    .update(cacheSalt)
    .update(accountId)
    .update(JSON.stringify(ordered))
    .digest('hex')
}

function cacheGet(key: string): ProviderResult | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expires <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.result
}

function cachePut(key: string, result: ProviderResult): void {
  cache.delete(key)
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, result })
  // Map keeps insertion order: drop the oldest entries.
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!)
}

// --- provider search ------------------------------------------------------

/** IMAP SEARCH criteria of a query (dates as UTC days). */
export function toSearchObject(query: SearchQuery): SearchObject {
  const criteria: SearchObject = {}
  if (query.q) criteria.text = query.q
  if (query.from) criteria.from = query.from
  if (query.subject) criteria.subject = query.subject
  if (query.since) criteria.since = new Date(`${query.since}T00:00:00Z`)
  if (query.before) criteria.before = new Date(`${query.before}T00:00:00Z`)
  return criteria
}

interface ImapAccount {
  host: string
  port: number
  user: string
  password: string
}

async function loadImapAccount(
  pool: Pool,
  accountId: string,
  wrappedDek: Buffer,
): Promise<ImapAccount> {
  const { rows } = await pool.query<{
    imap_host: string
    imap_port: number
    credential_enc: Buffer
  }>('SELECT imap_host, imap_port, credential_enc FROM mail_account WHERE id = $1', [accountId])
  const row = rows[0]!
  const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', wrappedDek)
  const credentials = JSON.parse(
    decryptField(dek, row.credential_enc.toString('utf8'), `mail_account.credential:${accountId}`),
  ) as { imapUser: string; imapPassword: string }
  return {
    host: row.imap_host,
    port: row.imap_port,
    user: credentials.imapUser,
    password: credentials.imapPassword,
  }
}

async function searchProvider(
  account: ImapAccount,
  folders: { id: string; path: string }[],
  criteria: SearchObject,
): Promise<ProviderResult> {
  let transport
  try {
    transport = await imapTransportOptions({
      host: account.host,
      port: account.port,
      secure: isSecurePort(account.port),
    })
  } catch {
    throw new SearchError('BLOCKED_HOST', 502, 'Interner IMAP-Host ist blockiert (SSRF-Schutz).')
  }
  const client = new ImapFlow({
    ...transport,
    auth: { user: account.user, pass: account.password },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
  })
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    client.close()
  }, SEARCH_DEADLINE_MS)
  try {
    try {
      await client.connect()
    } catch (err) {
      if (isStartTlsUnavailable(err)) {
        throw new SearchError(
          'TLS_REQUIRED',
          502,
          'Der Mailserver bietet keine verschlüsselte Verbindung (STARTTLS) an.',
        )
      }
      if ((err as { authenticationFailed?: boolean }).authenticationFailed) {
        throw new SearchError('AUTH_FAILED', 502, 'Der Anbieter hat die Zugangsdaten abgelehnt.')
      }
      throw err
    }
    const result: ProviderResult = { folders: [], foldersFailed: 0 }
    for (const folder of folders) {
      if (timedOut) break
      let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | null = null
      try {
        lock = await client.getMailboxLock(folder.path, { readOnly: true })
        const mailbox = client.mailbox
        const uids = (await client.search(criteria, { uid: true })) || []
        result.folders.push({
          folderId: folder.id,
          uidvalidity: mailbox ? String(mailbox.uidValidity) : '',
          uids: [...uids].sort((a, b) => b - a),
        })
      } catch {
        // e.g. folder removed at the provider: the other folders still count.
        if (timedOut || !client.usable) break
        result.foldersFailed++
      } finally {
        lock?.release()
      }
    }
    if (timedOut) throw new SearchError('TIMEOUT', 504, 'Die Suche beim Anbieter dauert zu lange.')
    return result
  } catch (err) {
    if (err instanceof SearchError) throw err
    if (timedOut) throw new SearchError('TIMEOUT', 504, 'Die Suche beim Anbieter dauert zu lange.')
    throw new SearchError('UNREACHABLE', 502, 'Der Mailanbieter ist nicht erreichbar.')
  } finally {
    clearTimeout(deadline)
    await client.logout().catch(() => client.close())
  }
}

// --- route ----------------------------------------------------------------

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/api/accounts/:id/search',
    { onRequest: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      const { rows: accounts } = UUID_RE.test(accountId)
        ? await pool.query<{ wrapped_dek: Buffer; status: string }>(
            'SELECT wrapped_dek, status FROM mail_account WHERE id = $1 AND user_id = $2',
            [accountId, request.auth!.userId],
          )
        : { rows: [] }
      const account = accounts[0]
      if (!account) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      const query = parseSearchQuery(request.query)
      if (typeof query === 'string') {
        await reply.code(400).send({ message: query })
        return
      }

      const { rows: folderRows } = await pool.query<{
        id: string
        path: string
        special_use: string | null
      }>(
        query.folderId
          ? `SELECT id, path, special_use FROM folder
             WHERE account_id = $1 AND id = $2 AND selectable`
          : `SELECT id, path, special_use FROM folder
             WHERE account_id = $1 AND selectable
               AND coalesce(special_use, '') NOT IN ('junk', 'trash')`,
        query.folderId ? [accountId, query.folderId] : [accountId],
      )
      if (query.folderId && folderRows.length === 0) {
        await reply.code(404).send({ message: 'Ordner nicht gefunden.' })
        return
      }
      const rank = (f: { path: string; special_use: string | null }) =>
        f.path.toUpperCase() === 'INBOX' ? -1 : (FOLDER_RANK[f.special_use ?? ''] ?? 10)
      const folders = folderRows
        .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
        .slice(0, MAX_FOLDERS)

      const key = cacheKey(accountId, query)
      let provider = cacheGet(key)
      if (!provider) {
        if (account.status === 'auth_error' || account.status === 'disabled') {
          await reply.code(409).send({
            message: 'Die Suche ist nicht möglich: Das Konto hat einen Anmeldefehler.',
          })
          return
        }
        if (!takeRateLimit(accountId)) {
          await reply
            .code(429)
            .send({ message: 'Zu viele Suchanfragen. Bitte in einer Minute erneut versuchen.' })
          return
        }
        try {
          const imap = await loadImapAccount(pool, accountId, account.wrapped_dek)
          provider = await searchProvider(imap, folders, toSearchObject(query))
        } catch (err) {
          const error =
            err instanceof SearchError
              ? err
              : new SearchError('UNREACHABLE', 502, 'Der Mailanbieter ist nicht erreichbar.')
          // Code only: provider responses may echo the query.
          request.log.warn({ accountId, code: error.code }, 'search failed')
          await reply.code(error.status).send({ message: error.message, code: error.code })
          return
        }
        cachePut(key, provider)
      }

      // Map the provider's UIDs to local messages (current UIDVALIDITY only).
      const dek = unwrapAccountKey(process.env.MASTER_KEY ?? '', account.wrapped_dek)
      const seen = new Set<string>()
      const results: SearchResultItem[] = []
      let providerMatches = 0
      let localMatches = 0
      let truncated = false
      for (const hits of provider.folders) {
        providerMatches += hits.uids.length
        const mapped = hits.uids.slice(0, MAX_MAPPED_UIDS)
        if (mapped.length < hits.uids.length) truncated = true
        if (mapped.length === 0) continue
        const { rows } = await pool.query<ListRow & { uid: string }>(
          `SELECT ${LIST_COLUMNS}, ml.uid
           FROM message_location ml JOIN message m ON m.id = ml.message_id
           WHERE ml.folder_id = $1 AND ml.uidvalidity = $2 AND ml.uid = ANY($3::bigint[])`,
          [hits.folderId, hits.uidvalidity || '-1', mapped],
        )
        localMatches += rows.length
        for (const row of rows) {
          // The same message in several folders (copies, Gmail labels): once.
          if (seen.has(row.id)) continue
          seen.add(row.id)
          results.push({ ...toListItem(request.log, dek, row), folderId: hits.folderId })
        }
      }
      results.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
      if (results.length > SEARCH_LIMITS.maxResults) truncated = true
      const body: SearchResponse = {
        messages: results.slice(0, SEARCH_LIMITS.maxResults),
        providerMatches,
        notSynced: Math.max(
          0,
          provider.folders.reduce((sum, f) => sum + Math.min(f.uids.length, MAX_MAPPED_UIDS), 0) -
            localMatches,
        ),
        truncated,
        foldersSearched: provider.folders.length,
        foldersFailed: provider.foldersFailed,
      }
      // Results contain decrypted content: never cached by the browser.
      await reply.header('cache-control', 'no-store').send(body)
    },
  )
}
