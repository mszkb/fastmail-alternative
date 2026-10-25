/**
 * Offline search (#162): the fallback of the global search when the server
 * is unreachable. Filters what the device has cached (first list pages per
 * folder, opened messages and threads) in memory - no index, nothing is
 * stored. Same criteria as the online search (parseSearchInput), here as
 * case-insensitive substrings:
 * - free text: subject, sender, preview and, for opened mails, the text;
 * - `to:` only matches opened mails (list entries carry no recipients);
 * - dates compare the UTC day of the message date;
 * - Spam/Trash are left out unless `includeJunk`, Gmail's "All Mail" never
 *   counts twice (one hit per message id).
 *
 * Kept free of DOM access so native clients can share it.
 */
import type { MailPerson, MessageDetail, MessageListItem } from './mail'
import type { GlobalSearchItem, SearchQuery } from './search'

/** A cached list entry with the folder (and its role) it was cached for. */
export interface OfflineListEntry {
  accountId: string
  folderId: string
  /** Folder role (`specialUse`), e.g. `junk`, `trash`, `all`. */
  folderRole: string | null
  message: MessageListItem
}

/** What the device knows about a folder (from the cached folder lists). */
export interface OfflineFolder {
  accountId: string
  role: string | null
}

const JUNK_ROLES = new Set(['junk', 'trash'])
const MAX_SNIPPET = 200

function contains(haystack: string | null | undefined, needle: string): boolean {
  return !!haystack && haystack.toLocaleLowerCase('de-DE').includes(needle)
}

function personMatches(person: MailPerson | null | undefined, needle: string): boolean {
  return !!person && (contains(person.name, needle) || contains(person.address, needle))
}

interface Candidate {
  accountId: string
  folderId: string
  folderRole: string | null
  message: MessageListItem
  detail: MessageDetail | null
}

function matches(c: Candidate, query: SearchQuery): boolean {
  const lower = (v: string | undefined): string | undefined =>
    v === undefined ? undefined : v.toLocaleLowerCase('de-DE')
  const q = lower(query.q)
  const from = lower(query.from)
  const to = lower(query.to)
  const subject = lower(query.subject)
  const { message, detail } = c
  if (query.folderId && c.folderId !== query.folderId) return false
  if (!query.includeJunk && !query.folderId && c.folderRole && JUNK_ROLES.has(c.folderRole))
    return false
  if (subject && !contains(message.subject, subject)) return false
  if (from && !personMatches(message.from, from)) return false
  if (to) {
    const recipients = detail ? [...detail.to, ...detail.cc] : []
    if (!recipients.some((p) => personMatches(p, to))) return false
  }
  if (q) {
    // Every word somewhere (like IMAP TEXT with several words).
    for (const word of q.split(/\s+/).filter(Boolean)) {
      const hit =
        contains(message.subject, word) ||
        personMatches(message.from, word) ||
        contains(message.snippet, word) ||
        contains(detail?.text, word)
      if (!hit) return false
    }
  }
  if (query.unread && message.flags.seen) return false
  if (query.attachment && !message.hasAttachments) return false
  const day = message.date.slice(0, 10)
  if (query.since && day < query.since) return false
  if (query.before && day >= query.before) return false
  return true
}

/** A list entry built from an opened message that is in no cached list. */
function listItemFromDetail(detail: MessageDetail): MessageListItem {
  const text = detail.text ?? ''
  return {
    id: detail.id,
    subject: detail.subject,
    from: detail.from,
    date: detail.date,
    snippet: text.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET),
    flags: detail.flags,
    hasAttachments: detail.hasAttachments,
    threadId: detail.threadId,
    threadCount: 1,
  }
}

/**
 * Searches the cached messages; one hit per message (a cached list entry
 * wins over the folder of an opened mail), newest first, at most `limit`.
 * `accountIds` limits the accounts (scope "Nur dieses Konto").
 */
export function searchOffline(
  lists: OfflineListEntry[],
  details: MessageDetail[],
  folders: Map<string, OfflineFolder>,
  query: SearchQuery,
  options: { accountIds?: string[]; limit?: number } = {},
): GlobalSearchItem[] {
  const byId = new Map<string, MessageDetail>()
  for (const detail of details) byId.set(detail.id, detail)
  const candidates = new Map<string, Candidate>()
  const add = (c: Candidate): void => {
    const existing = candidates.get(c.message.id)
    // Same message in several folders: the searched folder, else not Gmail's "All Mail".
    const better = !existing
      ? true
      : query.folderId
        ? c.folderId === query.folderId && existing.folderId !== query.folderId
        : existing.folderRole === 'all' && c.folderRole !== 'all'
    if (better) candidates.set(c.message.id, c)
  }
  for (const entry of lists) {
    add({ ...entry, detail: byId.get(entry.message.id) ?? null })
  }
  for (const detail of details) {
    const listed = candidates.get(detail.id)
    if (listed && (!query.folderId || listed.folderId === query.folderId)) continue
    for (const folderId of detail.folderIds) {
      add({
        accountId: detail.accountId,
        folderId,
        folderRole: folders.get(folderId)?.role ?? null,
        message: listItemFromDetail(detail),
        detail,
      })
    }
  }
  const accounts = options.accountIds ? new Set(options.accountIds) : null
  const hits: GlobalSearchItem[] = []
  for (const c of candidates.values()) {
    if (accounts && !accounts.has(c.accountId)) continue
    if (!matches(c, query)) continue
    hits.push({ ...c.message, accountId: c.accountId, folderId: c.folderId, uid: 0, synced: true })
  }
  hits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return options.limit === undefined ? hits : hits.slice(0, options.limit)
}
