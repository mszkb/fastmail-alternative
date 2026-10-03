/**
 * Offline-first rules (roadmap 4.6, ADR-0010): the client keeps a local
 * cache of what the user has seen and an offline queue of actions that
 * could not reach the server. The server stays the source of truth; the
 * queue is replayed in order once the app is online again.
 *
 * Pure logic (no IndexedDB, no fetch) so native clients follow the same
 * rules and everything is testable:
 * - queueOperation: appends to the queue and coalesces flag changes
 *   (read -> unread -> read is sent once as "read") and draft saves (only
 *   the newest save or delete of a draft is kept, a send drops the queued
 *   saves of its draft).
 * - replayDecision: what to do with a replayed operation given the HTTP
 *   status (done, retry later, drop with a notice, session gone).
 * - applyMessageAction / overlayPendingActions: the optimistic effect of
 *   (queued) actions on a message list, also after a reload.
 * - selectEvictions: LRU eviction that keeps the cache within its limits.
 */
import type { SaveDraftRequest } from './drafts'
import type { MessageAction, MessageActionRequest, MessageFlags, SendMessageRequest } from './mail'

interface QueuedBase {
  /** Client-generated UUID; for sends also the outbox `clientId` (idempotency). */
  id: string
  accountId: string
  createdAt: string
  /** Replay attempts that got a retryable server answer (not network errors). */
  attempts: number
}

export interface QueuedMessageAction extends QueuedBase {
  kind: 'action'
  request: MessageActionRequest
}

export interface QueuedSend extends QueuedBase {
  kind: 'send'
  /** `clientId` equals the operation id, so a replay never sends twice. */
  request: SendMessageRequest & { clientId: string }
}

export interface QueuedDraft extends QueuedBase {
  kind: 'draft'
  /** `body` null deletes the draft; otherwise saved with `force` (last write wins). */
  request: { draftId: string; body: SaveDraftRequest | null }
}

export type QueuedOperation = QueuedMessageAction | QueuedSend | QueuedDraft

/** Actions that only toggle a flag; the last one per message wins. */
const FLAG_GROUP: Partial<Record<MessageAction, 'seen' | 'flagged'>> = {
  read: 'seen',
  unread: 'seen',
  flag: 'flagged',
  unflag: 'flagged',
}

/** Actions that take the message out of its folder. */
export function removesFromFolder(action: MessageAction): boolean {
  return action === 'archive' || action === 'delete' || action === 'move'
}

/**
 * Appends an operation to the queue (returns a new array). A flag action
 * replaces earlier queued actions of the same flag group on the same
 * messages in the same folder, as long as no move/archive/delete of that
 * message lies in between (the earlier one then ran in another folder).
 */
export function queueOperation(
  queue: readonly QueuedOperation[],
  operation: QueuedOperation,
): QueuedOperation[] {
  if (operation.kind === 'draft') {
    // Only the newest state of a draft matters (PUT is a full replace).
    const id = operation.request.draftId
    return [
      ...queue.filter((entry) => entry.kind !== 'draft' || entry.request.draftId !== id),
      operation,
    ]
  }
  if (operation.kind === 'send' && operation.request.draftId) {
    // Sending deletes the draft anyway: its queued saves are obsolete.
    const id = operation.request.draftId
    return [
      ...queue.filter((entry) => entry.kind !== 'draft' || entry.request.draftId !== id),
      operation,
    ]
  }
  if (operation.kind !== 'action') return [...queue, operation]
  const group = FLAG_GROUP[operation.request.action]
  if (!group) return [...queue, operation]

  // Message ids whose earlier flag changes are superseded by this operation.
  const open = new Set(operation.request.messageIds)
  const result: QueuedOperation[] = []
  for (let i = queue.length - 1; i >= 0; i--) {
    const entry = queue[i]!
    if (open.size === 0 || entry.kind !== 'action' || entry.accountId !== operation.accountId) {
      result.unshift(entry)
      continue
    }
    const touched = entry.request.messageIds.filter((id) => open.has(id))
    if (touched.length === 0) {
      result.unshift(entry)
      continue
    }
    if (removesFromFolder(entry.request.action)) {
      // Older flag changes of these messages happened elsewhere: keep them.
      for (const id of touched) open.delete(id)
      result.unshift(entry)
      continue
    }
    if (
      FLAG_GROUP[entry.request.action] === group &&
      entry.request.folderId === operation.request.folderId
    ) {
      const rest = entry.request.messageIds.filter((id) => !open.has(id))
      if (rest.length > 0) {
        result.unshift({ ...entry, request: { ...entry.request, messageIds: rest } })
      }
      continue
    }
    result.unshift(entry)
  }
  return [...result, operation]
}

export type ReplayDecision =
  /** Accepted by the server: remove from the queue. */
  | 'done'
  /** Try again later; stop this replay run so the order is kept. */
  | 'retry'
  /** Refused for good (e.g. message gone): remove and tell the user. */
  | 'drop'
  /** Session expired or revoked: stop, the app clears its offline data. */
  | 'unauthorized'

/** Retries of a 409 (e.g. moved message without its new UID yet, a few seconds). */
export const MAX_CONFLICT_ATTEMPTS = 3
/** Retries of server errors / rate limits before an operation is given up. */
export const MAX_REPLAY_ATTEMPTS = 10

/**
 * Decides what happens to a replayed operation. `status` is the HTTP
 * status, or 'network' when the request did not reach the server (does not
 * count as an attempt). `attempts` counts earlier retryable answers.
 */
export function replayDecision(status: number | 'network', attempts: number): ReplayDecision {
  if (status === 'network') return 'retry'
  if (status >= 200 && status < 300) return 'done'
  if (status === 401) return 'unauthorized'
  if (status === 409) return attempts + 1 < MAX_CONFLICT_ATTEMPTS ? 'retry' : 'drop'
  if (status === 408 || status === 429 || status >= 500) {
    return attempts + 1 < MAX_REPLAY_ATTEMPTS ? 'retry' : 'drop'
  }
  return 'drop'
}

/** German label of the pending indicator, e.g. "3 Aktionen ausstehend". */
export function pendingLabel(count: number): string {
  return count === 1 ? '1 Aktion ausstehend' : `${count} Aktionen ausstehend`
}

/**
 * Applies a message action to a list (returns a new array, entries that
 * change are copied): flag actions set the flag, move/archive/delete remove
 * the messages from the list of their folder.
 */
export function applyMessageAction<T extends { id: string; flags: MessageFlags }>(
  messages: readonly T[],
  action: MessageAction,
  ids: readonly string[],
): T[] {
  const idSet = new Set(ids)
  if (removesFromFolder(action)) return messages.filter((m) => !idSet.has(m.id))
  const group = FLAG_GROUP[action]
  if (!group) return [...messages]
  const value = action === 'read' || action === 'flag'
  return messages.map((m) =>
    idSet.has(m.id) && m.flags[group] !== value
      ? { ...m, flags: { ...m.flags, [group]: value } }
      : m,
  )
}

/**
 * Applies the queued actions of a folder to a list freshly loaded from the
 * cache or the server, so pending changes stay visible until replayed.
 */
export function overlayPendingActions<T extends { id: string; flags: MessageFlags }>(
  messages: readonly T[],
  folderId: string,
  queue: readonly QueuedOperation[],
): T[] {
  let result = [...messages]
  for (const entry of queue) {
    if (entry.kind !== 'action' || entry.request.folderId !== folderId) continue
    result = applyMessageAction(result, entry.request.action, entry.request.messageIds)
  }
  return result
}

/** Metadata of one cache entry for the eviction policy. */
export interface CacheEntryInfo {
  key: string
  /** Stored size in bytes. */
  size: number
  /** Last read or write (ms since epoch). */
  accessedAt: number
  /** Pinned entries (account and folder lists) are never evicted. */
  pinned?: boolean
}

export interface CacheLimits {
  maxBytes: number
  maxEntries: number
}

/** Default bound of the client cache: plenty for the mails a user reads. */
export const DEFAULT_CACHE_LIMITS: CacheLimits = { maxBytes: 50 * 1024 * 1024, maxEntries: 3000 }

/**
 * Keys to evict so the cache fits its limits: least recently used first,
 * pinned entries never (they count towards the limits nevertheless).
 */
export function selectEvictions(
  entries: readonly CacheEntryInfo[],
  limits: CacheLimits = DEFAULT_CACHE_LIMITS,
): string[] {
  let bytes = entries.reduce((sum, e) => sum + e.size, 0)
  let count = entries.length
  if (bytes <= limits.maxBytes && count <= limits.maxEntries) return []
  const candidates = entries
    .filter((e) => !e.pinned)
    .sort((a, b) => a.accessedAt - b.accessedAt || a.key.localeCompare(b.key))
  const evicted: string[] = []
  for (const entry of candidates) {
    if (bytes <= limits.maxBytes && count <= limits.maxEntries) break
    evicted.push(entry.key)
    bytes -= entry.size
    count--
  }
  return evicted
}
