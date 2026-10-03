/**
 * Search (roadmap 5.1, ADR-0006): per account via IMAP SEARCH at the
 * provider - no search index, no plaintext in the database. Shapes of
 * `GET /api/accounts/:id/search` and the parameter validation shared by
 * api and clients.
 */
import type { MessageListItem } from './mail'

export const SEARCH_LIMITS = {
  /** Characters per text criterion. */
  maxTermLength: 200,
  /** Local messages returned per search (newest first). */
  maxResults: 100,
} as const

/** Criteria of a search; text criteria match substrings (IMAP semantics). */
export interface SearchQuery {
  /** Any text in headers and body (IMAP TEXT). */
  q?: string
  from?: string
  subject?: string
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
  for (const key of ['q', 'from', 'subject'] as const) {
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
  const folderId = input.folderId
  if (folderId !== undefined && folderId !== '') {
    if (typeof folderId !== 'string' || !UUID_RE.test(folderId)) return 'Ungültiger Ordner.'
    query.folderId = folderId.toLowerCase()
  }
  if (!query.q && !query.from && !query.subject && !query.since && !query.before) {
    return 'Bitte einen Suchbegriff oder Zeitraum angeben.'
  }
  return query
}

/** Query string of a search request (empty criteria left out). */
export function searchQueryString(query: SearchQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value) params.set(key, value)
  }
  return params.toString()
}
