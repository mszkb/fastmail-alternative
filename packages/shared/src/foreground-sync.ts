/**
 * Client sync rules (roadmap 4.5): the app is current without push.
 *
 * On start, when it becomes visible/focused again and when it comes back
 * online, a client asks the server to sync (POST /api/sync) and refreshes
 * its data. Afterwards it polls the account list (GET /api/accounts) every
 * few seconds while a sync is still running, for a limited window, and
 * reloads the views of an account whose state changed. Without a trigger
 * the regular account refresh (every 60 s while visible) picks up the
 * results of the periodic server-side sync the same way.
 *
 * Kept free of DOM/timer access so native clients can follow the same
 * rules (ADR-0010) and the logic is testable.
 */

/** Minimal account state the client compares between two refreshes. */
export interface AccountSyncState {
  id: string
  lastSyncAt: string | null
  syncing: boolean
  unreadCount: number
}

export interface ForegroundSyncOptions {
  /** Focus/visibility/online events closer together than this are ignored. */
  minTriggerIntervalMs?: number
  /** Account list poll interval while a triggered sync is running. */
  pollIntervalMs?: number
  /** Polling stops this long after the trigger, even if a sync still runs. */
  pollWindowMs?: number
  now?: () => number
}

export class ForegroundSyncPolicy {
  private readonly minTriggerIntervalMs: number
  private readonly pollIntervalMs: number
  private readonly pollWindowMs: number
  private readonly now: () => number
  private lastTrigger = Number.NEGATIVE_INFINITY
  private pollUntil = Number.NEGATIVE_INFINITY

  constructor(options: ForegroundSyncOptions = {}) {
    // The server rate-limits sync requests per account to one per 30 s;
    // the client throttle only keeps focus + visibilitychange pairs and
    // quick tab switches from sending needless requests.
    this.minTriggerIntervalMs = options.minTriggerIntervalMs ?? 15_000
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000
    this.pollWindowMs = options.pollWindowMs ?? 120_000
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Whether a trigger event should request a sync now; records the trigger
   * and opens the poll window when it does. `force` (app start, login)
   * bypasses the throttle.
   */
  trigger(force = false): boolean {
    const now = this.now()
    if (!force && now - this.lastTrigger < this.minTriggerIntervalMs) return false
    this.lastTrigger = now
    this.pollUntil = now + this.pollWindowMs
    return true
  }

  /**
   * Delay until the next account list poll after a refresh, or null when
   * fast polling should stop (nothing syncing anymore, or window over).
   */
  nextPollDelay(anySyncing: boolean): number | null {
    if (!anySyncing) {
      this.pollUntil = Number.NEGATIVE_INFINITY
      return null
    }
    return this.now() < this.pollUntil ? this.pollIntervalMs : null
  }

  /** Stops fast polling (e.g. on logout or when the app is hidden). */
  stop(): void {
    this.pollUntil = Number.NEGATIVE_INFINITY
  }
}

/**
 * True when the server has new data for the account since the previous
 * refresh: a sync finished (last_sync_at moved or `syncing` ended) or the
 * unread count changed (e.g. read on another device). Unknown previous
 * state counts as unchanged - the view was just loaded anyway.
 */
export function accountDataChanged(
  prev: AccountSyncState | undefined,
  next: AccountSyncState,
): boolean {
  if (!prev || prev.id !== next.id) return false
  return (
    prev.lastSyncAt !== next.lastSyncAt ||
    (prev.syncing && !next.syncing) ||
    prev.unreadCount !== next.unreadCount
  )
}

/**
 * Merges a freshly loaded first page of a message list into the list the
 * user is looking at, without dropping pages loaded by scrolling: the new
 * first page replaces the head (new messages appear, removed ones vanish),
 * the already loaded tail after the last message of the new page is kept.
 * The cursor stays the one of the loaded tail, or becomes the new page's
 * cursor when nothing beyond the first page was loaded.
 */
export function mergeFirstPage<T extends { id: string }>(
  current: { messages: T[]; nextCursor: string | null },
  firstPage: { messages: T[]; nextCursor: string | null },
): { messages: T[]; nextCursor: string | null } {
  const last = firstPage.messages[firstPage.messages.length - 1]
  const boundary = last ? current.messages.findIndex((m) => m.id === last.id) : -1
  // Boundary unknown (e.g. the page shifted completely): the first page
  // alone is consistent with its cursor.
  if (boundary < 0) return firstPage
  const ids = new Set(firstPage.messages.map((m) => m.id))
  const tail = current.messages.slice(boundary + 1).filter((m) => !ids.has(m.id))
  if (tail.length === 0) return firstPage
  return { messages: [...firstPage.messages, ...tail], nextCursor: current.nextCursor }
}
