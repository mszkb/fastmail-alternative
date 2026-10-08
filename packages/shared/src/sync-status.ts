/**
 * Sync progress and stopping (#119), client side: types of
 * GET /api/sync/status and the cancel endpoints, the German texts of the
 * sync panel and the polling rule.
 *
 * - The status only carries ids and numbers; the client resolves the
 *   folder name from its folder list (principles 5/6).
 * - Polling runs only while a sync of some account is active (queued,
 *   running, cancelling), every SYNC_STATUS_POLL_MS; afterwards it stops.
 * - Backends without the endpoints (e.g. an older server) answer 404:
 *   the client then derives the state from the `syncing` flag of
 *   GET /api/accounts (syncStatusFromAccounts) and offers no stop button.
 *
 * Kept free of DOM/timer access so native clients can share the rules.
 */
import { ACCOUNT_ERROR_MESSAGES } from './mail'
import type { AccountErrorCode, AccountSummary } from './mail'

export type SyncState =
  'idle' | 'queued' | 'running' | 'cancelling' | 'error' | 'auth_error' | 'paused'

export type SyncPhase = 'folders' | 'headers' | 'bodies' | 'flags' | 'expunge'

/** One account of GET /api/sync/status. */
export interface AccountSyncStatus {
  accountId: string
  state: SyncState
  phase: SyncPhase | null
  folderId: string | null
  done: number | null
  total: number | null
  startedAt: string | null
  updatedAt: string | null
  queuedJobs: number
  lastSyncAt: string | null
  nextRunAt: string | null
  lastErrorCode: string | null
}

export interface SyncStatusResponse {
  accounts: AccountSyncStatus[]
}

/** Response of POST /api/accounts/:id/sync/cancel (and per account of /api/sync/cancel). */
export interface SyncCancelResult {
  accountId: string
  cancelledQueued: number
  cancelling: boolean
}

/** Poll interval of the status while a sync runs. */
export const SYNC_STATUS_POLL_MS = 2_500
/**
 * Only waiting syncs for this long (e.g. no cron/worker running): poll
 * every SYNC_STATUS_SLOW_POLL_MS instead, until one starts.
 */
export const SYNC_STATUS_QUEUED_PATIENCE_MS = 120_000
export const SYNC_STATUS_SLOW_POLL_MS = 30_000

/** A sync is queued, running or stopping: keep polling. */
export function isSyncActive(status: Pick<AccountSyncStatus, 'state'> | undefined): boolean {
  return status?.state === 'queued' || status?.state === 'running' || status?.state === 'cancelling'
}

/**
 * The refresh button spins: a sync is queued or running. A stopping sync
 * does not spin any more - the stop ends the animation at once.
 */
export function isSyncBusy(status: Pick<AccountSyncStatus, 'state'> | undefined): boolean {
  return status?.state === 'queued' || status?.state === 'running'
}

/** The account needs attention (error dot on the indicator). */
export function isSyncError(status: Pick<AccountSyncStatus, 'state'> | undefined): boolean {
  return status?.state === 'error' || status?.state === 'auth_error'
}

/**
 * Delay until the next status poll, or null when nothing is active.
 * `onlyQueuedForMs`: how long all active syncs have only been waiting.
 */
export function nextSyncStatusPoll(
  statuses: Pick<AccountSyncStatus, 'state'>[],
  onlyQueuedForMs = 0,
): number | null {
  if (!statuses.some(isSyncActive)) return null
  const onlyQueued = statuses.every((s) => !isSyncActive(s) || s.state === 'queued')
  return onlyQueued && onlyQueuedForMs >= SYNC_STATUS_QUEUED_PATIENCE_MS
    ? SYNC_STATUS_SLOW_POLL_MS
    : SYNC_STATUS_POLL_MS
}

/** Only waiting (no running or stopping) syncs among the active ones. */
export function onlyQueuedSyncs(statuses: Pick<AccountSyncStatus, 'state'>[]): boolean {
  return (
    statuses.some(isSyncActive) && statuses.every((s) => !isSyncActive(s) || s.state === 'queued')
  )
}

/** Accounts whose sync was active before and is not any more. */
export function finishedSyncs(
  previous: Pick<AccountSyncStatus, 'accountId' | 'state'>[],
  next: Pick<AccountSyncStatus, 'accountId' | 'state'>[],
): string[] {
  const now = new Map(next.map((s) => [s.accountId, s]))
  return previous
    .filter((s) => isSyncActive(s) && !isSyncActive(now.get(s.accountId)))
    .map((s) => s.accountId)
}

/**
 * Fallback for backends without GET /api/sync/status: running while
 * `syncing`, errors from the account status; no progress, no stop.
 */
export function syncStatusFromAccounts(
  accounts: Array<
    Pick<AccountSummary, 'id'> &
      Partial<
        Pick<AccountSummary, 'syncing' | 'status' | 'lastErrorCode' | 'lastSyncAt' | 'nextRetryAt'>
      >
  >,
): AccountSyncStatus[] {
  return accounts.map((account) => {
    const state: SyncState =
      account.status === 'auth_error'
        ? 'auth_error'
        : account.status === 'disabled'
          ? 'paused'
          : account.syncing
            ? 'running'
            : account.status === 'unreachable'
              ? 'error'
              : 'idle'
    return {
      accountId: account.id,
      state,
      phase: null,
      folderId: null,
      done: null,
      total: null,
      startedAt: null,
      updatedAt: null,
      queuedJobs: 0,
      lastSyncAt: account.lastSyncAt ?? null,
      nextRunAt: state === 'error' ? (account.nextRetryAt ?? null) : null,
      lastErrorCode: account.lastErrorCode ?? null,
    }
  })
}

const PHASE_LABELS: Record<SyncPhase, string> = {
  folders: 'Ordnerliste',
  flags: 'Markierungen abgleichen',
  expunge: 'Gelöschte entfernen',
  headers: 'Neue Nachrichten laden',
  bodies: 'Inhalte nachladen',
}

export function syncPhaseLabel(phase: SyncPhase | null): string | null {
  return phase ? PHASE_LABELS[phase] : null
}

/** 8000 -> "8 000" (narrow no-break space as thousands separator). */
export function formatSyncCount(value: number): string {
  return String(Math.max(0, Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * Progress line of the panel, e.g. "Posteingang – 1 240 / 8 000
 * Nachrichten"; null without progress. `folderName` comes from the
 * client's folder list (null: not known yet).
 */
export function syncProgressText(
  status: Pick<AccountSyncStatus, 'phase' | 'done' | 'total' | 'folderId'>,
  folderName: string | null,
): string | null {
  if (!status.phase) return null
  const counts =
    status.total !== null && status.total > 0
      ? `${formatSyncCount(status.done ?? 0)} / ${formatSyncCount(status.total)}`
      : null
  if (status.phase === 'folders') {
    return counts ? `Ordnerliste – ${counts} Ordner` : 'Ordnerliste'
  }
  const folder = folderName ?? (status.folderId ? 'Ordner' : '')
  const unit = status.phase === 'headers' || status.phase === 'bodies' ? ' Nachrichten' : ''
  if (!counts) return folder || null
  return folder ? `${folder} – ${counts}${unit}` : `${counts}${unit}`
}

/** Share done/total in [0, 1], or null when unknown (indeterminate). */
export function syncFraction(status: Pick<AccountSyncStatus, 'done' | 'total'>): number | null {
  if (status.total === null || status.total <= 0 || status.done === null) return null
  return Math.min(1, Math.max(0, status.done / status.total))
}

/** Short state text of an account in the panel. */
export function syncStateText(status: Pick<AccountSyncStatus, 'state' | 'lastErrorCode'>): string {
  switch (status.state) {
    case 'running':
      return 'Wird synchronisiert'
    case 'queued':
      return 'Wartet auf den Abgleich'
    case 'cancelling':
      return 'Wird gestoppt …'
    case 'auth_error':
      return status.lastErrorCode === 'CREDENTIALS_REQUIRED'
        ? 'Passwort fehlt – Zugangsdaten eingeben'
        : 'Anmeldung fehlgeschlagen – Zugangsdaten prüfen'
    case 'error': {
      const reason = ACCOUNT_ERROR_MESSAGES[status.lastErrorCode as AccountErrorCode]
      return reason ? `Fehler – ${reason}` : 'Fehler – Server nicht erreichbar'
    }
    case 'paused':
      return 'Abgleich deaktiviert'
    default:
      return 'Aktuell'
  }
}

/** Elapsed time of a running sync: "0:42", "12:05", "1:02:03". */
export function formatSyncDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}
