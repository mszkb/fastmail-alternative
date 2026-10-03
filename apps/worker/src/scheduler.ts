/**
 * Periodic sync scheduler (roadmap 2.2): enqueues a folder_sync job for every
 * active account whose last sync is older than the sync interval. The
 * folder_sync job chains one message_sync per folder. This polling is the
 * fallback next to IMAP IDLE (./idle, INBOX only).
 *
 * - No pile-up: an account with a queued or running folder_sync gets no new
 *   one. Failed jobs stay 'queued' with a future run_at (backoff in
 *   @fma/db/job-queue), so retries are respected automatically.
 * - Per-account isolation: every account is evaluated independently; an
 *   account whose last folder_sync failed terminally is retried only after
 *   FAILED_RETRY_INTERVAL. Accounts with status 'disabled' or 'auth_error'
 *   (no automatic retry until the credentials are updated) or a future
 *   next_retry_at (circuit breaker backoff, ./account-health) are skipped.
 */
import type { Pool } from '@fma/db'
import { MAX_JOB_ATTEMPTS } from '@fma/db/job-queue'

const DEFAULT_SYNC_INTERVAL_SECONDS = 120
/** Retry interval after a folder_sync ran out of attempts (state 'failed'). */
const FAILED_RETRY_INTERVAL_SECONDS = 60 * 60
/**
 * A job 'running' longer than this is assumed lost (worker crash); longer
 * than the hard job timeout of the runner (max. 15 min).
 */
const STALE_RUNNING_SECONDS = 30 * 60

/** Sync interval per account from SYNC_INTERVAL_SECONDS (default 120). */
export function syncIntervalSeconds(): number {
  const value = Number(process.env.SYNC_INTERVAL_SECONDS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SYNC_INTERVAL_SECONDS
}

/**
 * Re-queues jobs stuck in 'running' (the worker died mid-job), so they
 * neither block their account nor get lost. Jobs that already used up
 * their attempts go to 'failed' instead: a job that crashes the worker
 * must not loop forever. `onGivenUp` runs for each of those (e.g. to mark
 * an outbox message as failed).
 *
 * `staleSeconds` 0 (worker startup) takes every running job: there is a
 * single worker instance, so they all belong to a previous process.
 */
export async function requeueStaleJobs(
  pool: Pool,
  staleSeconds = STALE_RUNNING_SECONDS,
  onGivenUp?: (job: { type: string; payload: Record<string, unknown> }) => Promise<void>,
): Promise<{ requeued: number; failed: number }> {
  const { rows } = await pool.query<{
    state: string
    type: string
    payload: Record<string, unknown>
  }>(
    `UPDATE job SET
       state = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
       last_error = CASE WHEN attempts >= $2 THEN 'WORKER_LOST' ELSE last_error END,
       run_at = now(), locked_at = NULL
     WHERE state = 'running'
       AND locked_at <= now() - ($1 || ' seconds')::interval
     RETURNING state, type, payload`,
    [String(staleSeconds), MAX_JOB_ATTEMPTS],
  )
  const failed = rows.filter((row) => row.state === 'failed')
  for (const job of failed) await onGivenUp?.(job)
  return { requeued: rows.length - failed.length, failed: failed.length }
}

/**
 * Enqueues folder_sync for every due account; returns the account ids that
 * got a new job. Safe to call often (single INSERT ... SELECT).
 */
export async function enqueueDueSyncs(
  pool: Pool,
  intervalSeconds = syncIntervalSeconds(),
): Promise<string[]> {
  const { rows } = await pool.query<{ account_id: string }>(
    `INSERT INTO job (type, account_id)
     SELECT 'folder_sync', ma.id FROM mail_account ma
     WHERE ma.status NOT IN ('disabled', 'auth_error')
       AND (ma.next_retry_at IS NULL OR ma.next_retry_at <= now())
       -- No pile-up: nothing queued (incl. backoff) or running.
       AND NOT EXISTS (
         SELECT 1 FROM job j
         WHERE j.type = 'folder_sync' AND j.account_id = ma.id
           AND j.state IN ('queued', 'running')
       )
       -- Due: last folder_sync is older than the interval (longer after a
       -- terminal failure).
       AND NOT EXISTS (
         SELECT 1 FROM job j
         WHERE j.type = 'folder_sync' AND j.account_id = ma.id
           AND j.created_at > now() - (
             CASE WHEN j.state = 'failed' THEN $2 ELSE $1 END || ' seconds'
           )::interval
       )
     RETURNING account_id`,
    [String(intervalSeconds), String(Math.max(intervalSeconds, FAILED_RETRY_INTERVAL_SECONDS))],
  )
  return rows.map((row) => String(row.account_id))
}

/**
 * Enqueues message_sync for one folder unless one is already queued or
 * running for it (a slow or backing-off folder must not pile up jobs).
 */
export async function enqueueMessageSync(
  pool: Pool,
  accountId: string,
  folderId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO job (type, account_id, payload)
     SELECT 'message_sync', $1::uuid, jsonb_build_object('folderId', $2::text)
     WHERE NOT EXISTS (
       SELECT 1 FROM job
       WHERE type = 'message_sync' AND account_id = $1::uuid
         AND payload->>'folderId' = $2::text
         AND state IN ('queued', 'running')
     )`,
    [accountId, folderId],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Enqueues the periodic cleanup job (roadmap 5.5, ./jobs/cleanup) unless
 * one is queued or running, or the last one was created less than
 * `intervalSeconds` ago. Returns whether a job was added.
 */
export async function enqueueDueCleanup(pool: Pool, intervalSeconds: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO job (type)
     SELECT 'cleanup'
     WHERE NOT EXISTS (
       SELECT 1 FROM job
       WHERE type = 'cleanup'
         AND (state IN ('queued', 'running')
           OR created_at > now() - ($1 || ' seconds')::interval)
     )`,
    [String(intervalSeconds)],
  )
  return (rowCount ?? 0) > 0
}
