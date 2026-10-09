/**
 * Search (roadmap 5.1, ADR-0006): via IMAP SEARCH at the provider - no
 * search index, no plaintext in the database. Shapes of
 * `GET /api/accounts/:id/search` (one account) and `GET /api/search` (all
 * accounts, #121), the parameter validation shared by api and clients and
 * the operators of the search field (`from:`, `is:unread`, ...).
 */
import type { MessageListItem } from './mail'

export const SEARCH_LIMITS = {
  /** Characters per text criterion. */
  maxTermLength: 200,
  /** Local messages returned per search (newest first). */
  maxResults: 100,
  /** Hits per page of the global search (server maximum: 100). */
  pageSize: 50,
} as const

/** Criteria of a search; text criteria match substrings (IMAP semantics). */
export interface SearchQuery {
  /** Any text in headers and body (IMAP TEXT). */
  q?: string
  from?: string
  /** Recipient (IMAP TO). */
  to?: string
  subject?: string
  /** Only unread messages (IMAP UNSEEN). */
  unread?: boolean
  /** Only messages with attachments (multipart/mixed). */
  attachment?: boolean
  /** Received on or after this day (YYYY-MM-DD, IMAP SINCE). */
  since?: string
  /** Received before this day (YYYY-MM-DD, exclusive, IMAP BEFORE). */
  before?: string
  /** Only this folder; default: INBOX and the other selectable folders except Junk/Trash. */
  folderId?: string
}

/** One hit: a locally stored message and the folder it was found in. */
export interface SearchResultItem extends MessageListItem {
  folderId: string
}

/** `GET /api/accounts/:id/search?q=&from=&subject=&since=&before=&folderId=` */
export interface SearchResponse {
  /** Matches stored locally, newest first (at most SEARCH_LIMITS.maxResults). */
  messages: SearchResultItem[]
  /** All matches the provider reported in the searched folders. */
  providerMatches: number
  /**
   * Matches without a local copy (not synced yet or outside the sync
   * window): shown as "weitere Treffer beim Anbieter".
   */
  notSynced: number
  /** More local matches than returned, or the provider returned too many to map. */
  truncated: boolean
  foldersSearched: number
  /** Folders that could not be searched (e.g. removed at the provider). */
  foldersFailed: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

/**
 * Validates and normalizes raw query parameters (trimmed, control
 * characters removed, empty values dropped). Returns a German error
 * message when invalid or when no criterion is given.
 */
export function parseSearchQuery(input: Record<string, unknown>): SearchQuery | string {
  const query: SearchQuery = {}
  for (const key of ['q', 'from', 'to', 'subject'] as const) {
    const raw = input[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return 'Ungültiger Suchbegriff.'
    const value = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
    if (value.length > SEARCH_LIMITS.maxTermLength) return 'Der Suchbegriff ist zu lang.'
    if (value) query[key] = value
  }
  for (const key of ['since', 'before'] as const) {
    const raw = input[key]
    if (raw === undefined || raw === '') continue
    if (typeof raw !== 'string' || !validDate(raw)) return 'Ungültiges Datum.'
    query[key] = raw
  }
  if (query.since && query.before && query.since >= query.before) {
    return 'Der Zeitraum ist leer.'
  }
  for (const key of ['unread', 'attachment'] as const) {
    const raw = input[key]
    if (raw === undefined || raw === '' || raw === false || raw === '0' || raw === 'false') continue
    if (raw !== true && raw !== '1' && raw !== 'true') return 'Ungültiger Filter.'
    query[key] = true
  }
  const folderId = input.folderId
  if (folderId !== undefined && folderId !== '') {
    if (typeof folderId !== 'string' || !UUID_RE.test(folderId)) return 'Ungültiger Ordner.'
    query.folderId = folderId.toLowerCase()
  }
  if (Object.keys(query).every((key) => key === 'folderId')) {
    return 'Bitte einen Suchbegriff oder Zeitraum angeben.'
  }
  return query
}

/** Query string of a search request (empty criteria left out). */
export function searchQueryString(query: SearchQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value) params.set(key, value)
    else if (value === true) params.set(key, '1')
  }
  return params.toString()
}

/** One hit of the global search: a local message, or headers from the provider. */
export interface GlobalSearchItem extends Omit<MessageListItem, 'id'> {
  /** Local message; null when the hit has no local copy yet (`synced: false`). */
  id: string | null
  accountId: string
  /** Folder the message was found in; actions run there. */
  folderId: string
  uid: number
  synced: boolean
}

export type GlobalSearchAccountStatus = 'ok' | 'timeout' | 'error' | 'auth_error' | 'rate_limited'

export interface GlobalSearchAccount {
  accountId: string
  status: GlobalSearchAccountStatus
  /** Stable error code when the status is not `ok`. */
  code?: string
  /** Matches at the provider (a message in several folders counts per folder). */
  matches: number
  foldersSearched: number
  foldersFailed: number
}

/** `GET /api/search?…&accounts=&limit=&cursor=` */
export interface GlobalSearchResponse {
  /** This page, newest first across accounts and folders. */
  messages: GlobalSearchItem[]
  /** One entry per searched account. */
  accounts: GlobalSearchAccount[]
  /** Sum of the accounts' matches (approximate). */
  total: number
  nextCursor: string | null
}

/** Where the global search looks (#121): all accounts, the active one or its open folder. */
export type GlobalSearchScope = 'all' | 'account' | 'folder'

/**
 * Path of a global search request. `account`/`folderId` apply for the
 * scopes `account` and `folder`; the cursor continues the same search.
 */
export function globalSearchPath(
  query: SearchQuery,
  options: {
    scope?: GlobalSearchScope
    accountId?: string
    folderId?: string
    cursor?: string | null
    limit?: number
  } = {},
): string {
  const params = new URLSearchParams(searchQueryString({ ...query, folderId: undefined }))
  const scope = options.scope ?? 'all'
  if (scope !== 'all' && options.accountId) params.set('accounts', options.accountId)
  if (scope === 'folder' && options.accountId && options.folderId)
    params.set('folderId', options.folderId)
  params.set('limit', String(options.limit ?? SEARCH_LIMITS.pageSize))
  if (options.cursor) params.set('cursor', options.cursor)
  return `/api/search?${params.toString()}`
}

/** German text for an account that could not be searched (null when ok). */
export function searchAccountProblem(
  account: Pick<GlobalSearchAccount, 'status' | 'code'>,
): string | null {
  switch (account.status) {
    case 'ok':
      return null
    case 'timeout':
      return 'Zeitüberschreitung'
    case 'auth_error':
      return 'Anmeldung beim Anbieter fehlgeschlagen'
    case 'rate_limited':
      return 'Zu viele Suchanfragen, bitte gleich erneut versuchen'
    default:
      return account.code === 'DISABLED' ? 'Konto ist deaktiviert' : 'Anbieter nicht erreichbar'
  }
}

/** Operators of the search field and the criterion each one sets. */
const OPERATORS: Record<string, keyof SearchQuery> = {
  from: 'from',
  to: 'to',
  subject: 'subject',
  before: 'before',
  after: 'since',
  since: 'since',
}

/**
 * Splits the text of the search field into criteria: `from:`, `to:`,
 * `subject:`, `before:`/`after:` (YYYY-MM-DD), `has:attachment` and
 * `is:unread`; values may be quoted (`from:"Anna Muster"`). Everything else
 * is free text (IMAP TEXT). Unknown operators stay free text. The result
 * still needs parseSearchQuery for validation.
 */
export function parseSearchInput(text: string): SearchQuery {
  const query: SearchQuery = {}
  const free: string[] = []
  const tokens = text.match(/(?:[^\s"]+:"[^"]*"?|"[^"]*"?|\S+)/g) ?? []
  for (const token of tokens) {
    const colon = token.indexOf(':')
    const name = colon > 0 ? token.slice(0, colon).toLowerCase() : ''
    const value = unquote(colon > 0 ? token.slice(colon + 1) : '')
    if (name === 'is' && value.toLowerCase() === 'unread') {
      query.unread = true
    } else if (name === 'has' && ['attachment', 'anhang'].includes(value.toLowerCase())) {
      query.attachment = true
    } else if (OPERATORS[name] && value) {
      const key = OPERATORS[name]
      ;(query as Record<string, string>)[key] = value.replace(/\//g, '-')
    } else {
      free.push(unquote(token))
    }
  }
  const q = free.join(' ').trim()
  if (q) query.q = q
  return query
}

function unquote(value: string): string {
  return value.replace(/^"/, '').replace(/"$/, '')
}

/** Words of a query to highlight in subjects (free text and `subject:`). */
export function highlightTerms(query: SearchQuery): string[] {
  const words = [query.q, query.subject]
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split(/\s+/))
    .filter((w) => w.length > 0)
  return [...new Set(words)].sort((a, b) => b.length - a.length)
}

/**
 * Splits a text into parts that match one of the terms (case-insensitive)
 * and the rest - for highlighting without HTML (no XSS via v-html).
 */
export function highlightParts(text: string, terms: string[]): { text: string; match: boolean }[] {
  if (terms.length === 0 || text === '') return [{ text, match: false }]
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts: { text: string; match: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(new RegExp(escaped.join('|'), 'giu'))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), match: false })
    parts.push({ text: m[0], match: true })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false })
  return parts
}
