import { describe, expect, it } from 'vitest'
import {
  SYNC_STATUS_POLL_MS,
  SYNC_STATUS_QUEUED_PATIENCE_MS,
  SYNC_STATUS_SLOW_POLL_MS,
  finishedSyncs,
  formatSyncCount,
  formatSyncDuration,
  isSyncActive,
  isSyncBusy,
  isSyncError,
  nextSyncStatusPoll,
  onlyQueuedSyncs,
  syncFraction,
  syncPhaseLabel,
  syncProgressText,
  syncStateText,
  syncStatusFromAccounts,
  type AccountSyncStatus,
  type SyncState,
} from '../src/sync-status'

function status(overrides: Partial<AccountSyncStatus> = {}): AccountSyncStatus {
  return {
    accountId: 'a',
    state: 'idle',
    phase: null,
    folderId: null,
    done: null,
    total: null,
    startedAt: null,
    updatedAt: null,
    queuedJobs: 0,
    lastSyncAt: null,
    nextRunAt: null,
    lastErrorCode: null,
    ...overrides,
  }
}

describe('sync state helpers', () => {
  const states: SyncState[] = [
    'idle',
    'queued',
    'running',
    'cancelling',
    'error',
    'auth_error',
    'paused',
  ]

  it('polls only while a sync is queued, running or stopping', () => {
    expect(states.filter((state) => isSyncActive({ state }))).toEqual([
      'queued',
      'running',
      'cancelling',
    ])
    expect(isSyncActive(undefined)).toBe(false)
    expect(nextSyncStatusPoll([{ state: 'idle' }, { state: 'running' }])).toBe(SYNC_STATUS_POLL_MS)
    expect(nextSyncStatusPoll([{ state: 'idle' }, { state: 'auth_error' }])).toBeNull()
    expect(nextSyncStatusPoll([])).toBeNull()
  })

  it('slows down when syncs only wait for a long time (no worker running)', () => {
    const queued = [{ state: 'queued' as const }, { state: 'idle' as const }]
    expect(onlyQueuedSyncs(queued)).toBe(true)
    expect(nextSyncStatusPoll(queued, 60_000)).toBe(SYNC_STATUS_POLL_MS)
    expect(nextSyncStatusPoll(queued, SYNC_STATUS_QUEUED_PATIENCE_MS)).toBe(
      SYNC_STATUS_SLOW_POLL_MS,
    )
    const running = [{ state: 'queued' as const }, { state: 'running' as const }]
    expect(onlyQueuedSyncs(running)).toBe(false)
    expect(nextSyncStatusPoll(running, 600_000)).toBe(SYNC_STATUS_POLL_MS)
    expect(onlyQueuedSyncs([{ state: 'idle' as const }])).toBe(false)
  })

  it('stops the spinner as soon as a stop is requested', () => {
    expect(states.filter((state) => isSyncBusy({ state }))).toEqual(['queued', 'running'])
    expect(states.filter((state) => isSyncError({ state }))).toEqual(['error', 'auth_error'])
  })

  it('reports accounts whose sync ended', () => {
    const before = [
      status({ accountId: 'a', state: 'running' }),
      status({ accountId: 'b', state: 'cancelling' }),
      status({ accountId: 'c', state: 'idle' }),
      status({ accountId: 'd', state: 'queued' }),
    ]
    const after = [
      status({ accountId: 'a', state: 'idle' }),
      status({ accountId: 'b', state: 'idle' }),
      status({ accountId: 'c', state: 'running' }),
      status({ accountId: 'd', state: 'running' }),
    ]
    expect(finishedSyncs(before, after)).toEqual(['a', 'b'])
    // A removed account counts as finished, so the view reloads once.
    expect(finishedSyncs(before, [])).toEqual(['a', 'b', 'd'])
  })
})

describe('syncStatusFromAccounts (backend without /api/sync/status)', () => {
  it('maps syncing and the account status', () => {
    const result = syncStatusFromAccounts([
      { id: 'a', syncing: true, status: 'ok' },
      { id: 'b', syncing: false, status: 'ok', lastSyncAt: '2026-10-07T10:00:00.000Z' },
      { id: 'c', status: 'auth_error', lastErrorCode: 'AUTH_FAILED', syncing: true },
      {
        id: 'd',
        status: 'unreachable',
        lastErrorCode: 'TIMEOUT',
        nextRetryAt: '2026-10-07T11:00:00.000Z',
      },
      { id: 'e', status: 'disabled' },
    ])
    expect(result.map((s) => s.state)).toEqual(['running', 'idle', 'auth_error', 'error', 'paused'])
    expect(result[1]!.lastSyncAt).toBe('2026-10-07T10:00:00.000Z')
    expect(result[3]!.nextRunAt).toBe('2026-10-07T11:00:00.000Z')
    expect(result[0]).toMatchObject({ phase: null, done: null, total: null, folderId: null })
  })
})

describe('texts', () => {
  it('formats counts with narrow spaces', () => {
    expect(formatSyncCount(0)).toBe('0')
    expect(formatSyncCount(999)).toBe('999')
    expect(formatSyncCount(1240)).toBe('1 240')
    expect(formatSyncCount(8000)).toBe('8 000')
    expect(formatSyncCount(1234567)).toBe('1 234 567')
  })

  it('builds the progress line from the folder name the client knows', () => {
    const running = status({
      state: 'running',
      phase: 'headers',
      folderId: 'f',
      done: 1240,
      total: 8000,
    })
    expect(syncProgressText(running, 'Posteingang')).toBe('Posteingang – 1 240 / 8 000 Nachrichten')
    expect(syncProgressText(running, null)).toBe('Ordner – 1 240 / 8 000 Nachrichten')
    expect(
      syncProgressText({ ...running, phase: 'folders', folderId: null, done: 3, total: 12 }, null),
    ).toBe('Ordnerliste – 3 / 12 Ordner')
    expect(
      syncProgressText({ ...running, phase: 'flags', done: null, total: null }, 'Archiv'),
    ).toBe('Archiv')
    expect(syncProgressText(status(), 'Archiv')).toBeNull()
  })

  it('labels phases and states in German', () => {
    expect(syncPhaseLabel('headers')).toBe('Neue Nachrichten laden')
    expect(syncPhaseLabel(null)).toBeNull()
    expect(syncStateText({ state: 'auth_error', lastErrorCode: 'AUTH_FAILED' })).toBe(
      'Anmeldung fehlgeschlagen – Zugangsdaten prüfen',
    )
    expect(syncStateText({ state: 'error', lastErrorCode: 'TIMEOUT' })).toBe(
      'Fehler – Der Mailserver antwortet nicht (Zeitüberschreitung).',
    )
    expect(syncStateText({ state: 'error', lastErrorCode: 'SOMETHING_NEW' })).toBe(
      'Fehler – Server nicht erreichbar',
    )
    expect(syncStateText({ state: 'cancelling', lastErrorCode: null })).toBe('Wird gestoppt …')
  })

  it('computes the progress share and the elapsed time', () => {
    expect(syncFraction({ done: 50, total: 200 })).toBe(0.25)
    expect(syncFraction({ done: 300, total: 200 })).toBe(1)
    expect(syncFraction({ done: null, total: 200 })).toBeNull()
    expect(syncFraction({ done: 0, total: 0 })).toBeNull()
    expect(formatSyncDuration(42_000)).toBe('0:42')
    expect(formatSyncDuration(725_000)).toBe('12:05')
    expect(formatSyncDuration(3_723_000)).toBe('1:02:03')
    expect(formatSyncDuration(-5)).toBe('0:00')
  })
})
