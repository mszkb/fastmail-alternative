/**
 * Client-triggered sync (roadmap 4.5): the app asks for a sync on start,
 * focus and when it comes back online, so it is current without push
 * (push is only a hint, docs/architecture/push.md).
 *
 * - POST /api/accounts/:id/sync enqueues a folder_sync for one account,
 *   POST /api/sync for all accounts of the user. The folder_sync chains the
 *   message_syncs per folder in the worker, like the periodic scheduler.
 * - Same rules as the scheduler (apps/worker/src/scheduler.ts): no job for
 *   disabled accounts, accounts with auth_error (no retry until the
 *   credentials are updated) or an open circuit breaker (next_retry_at in
 *   the future), and no pile-up while a folder_sync is queued or running.
 * - Rate limit per account: no new folder_sync when the last one (from any
 *   source) was created less than SYNC_REQUEST_MIN_INTERVAL_SECONDS ago -
 *   stored in the job table, so it holds across api instances and devices.
 * - Clients see the progress via `syncing` in GET /api/accounts.
 */
import type { FastifyInstance } from 'fastify'
import type { Pool } from '@fma/db'
import type { SyncAllResponse, SyncRequestResult, SyncSkipReason } from '@fma/shared'
import { requireAuth } from '../auth/routes'

export const SYNC_REQUEST_MIN_INTERVAL_SECONDS = 30

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Select-list column for mail_account rows: a sync job of the account is
 * running, or queued and claimable (a job waiting for its retry backoff or
 * an open circuit does not count, it would keep clients polling).
 */
export const SYNCING_COLUMN = `EXISTS (
    SELECT 1 FROM job j
    WHERE j.account_id = mail_account.id
      AND j.type IN ('folder_sync', 'message_sync')
      AND (j.state = 'running' OR (
        j.state = 'queued' AND j.run_at <= now()
        AND mail_account.status NOT IN ('disabled', 'auth_error')
        AND (mail_account.next_retry_at IS NULL OR mail_account.next_retry_at <= now())
      ))
  ) AS syncing`

interface SyncRow {
  id: string
  status: string
  next_retry_at: Date | null
  pending: boolean
  last_requested_at: Date | null
  queued: boolean
}

/**
 * Enqueues folder_sync for the given account (or all accounts of the user)
 * where allowed; one statement, like the scheduler. Returns one result per
 * account (empty: no such account of this user).
 */
export async function requestSync(
  pool: Pool,
  userId: string,
  accountId: string | null,
  minIntervalSeconds = SYNC_REQUEST_MIN_INTERVAL_SECONDS,
): Promise<SyncRequestResult[]> {
  const { rows } = await pool.query<SyncRow>(
    `WITH acc AS (
       SELECT ma.id, ma.status, ma.next_retry_at, ma.sort_order, ma.created_at,
         EXISTS (
           SELECT 1 FROM job j
           WHERE j.type = 'folder_sync' AND j.account_id = ma.id
             AND j.state IN ('queued', 'running')
         ) AS pending,
         (SELECT max(j.created_at) FROM job j
          WHERE j.type = 'folder_sync' AND j.account_id = ma.id) AS last_requested_at
       FROM mail_account ma
       WHERE ma.user_id = $1 AND ($2::uuid IS NULL OR ma.id = $2::uuid)
     ), ins AS (
       INSERT INTO job (type, account_id)
       SELECT 'folder_sync', acc.id FROM acc
       WHERE acc.status NOT IN ('disabled', 'auth_error')
         AND (acc.next_retry_at IS NULL OR acc.next_retry_at <= now())
         AND NOT acc.pending
         AND (acc.last_requested_at IS NULL
           OR acc.last_requested_at <= now() - make_interval(secs => $3))
       RETURNING account_id
     )
     SELECT acc.id, acc.status, acc.next_retry_at, acc.pending, acc.last_requested_at,
       (ins.account_id IS NOT NULL) AS queued
     FROM acc LEFT JOIN ins ON ins.account_id = acc.id
     ORDER BY acc.sort_order, acc.created_at`,
    [userId, accountId, minIntervalSeconds],
  )
  return rows.map((row) => ({
    accountId: row.id,
    queued: row.queued,
    reason: row.queued ? null : skipReason(row),
  }))
}

/** Same order of checks as the WHERE clause above. */
function skipReason(row: SyncRow): SyncSkipReason {
  if (row.status === 'disabled') return 'disabled'
  if (row.status === 'auth_error') return 'auth_error'
  if (row.next_retry_at && row.next_retry_at.getTime() > Date.now()) return 'backoff'
  if (row.pending) return 'pending'
  return 'rate_limited'
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.post<{ Params: { id: string } }>(
    '/api/accounts/:id/sync',
    { onRequest: requireAuth },
    async (request, reply) => {
      const accountId = request.params.id
      const [result] = UUID_RE.test(accountId)
        ? await requestSync(pool, request.auth!.userId, accountId)
        : []
      if (!result) {
        await reply.code(404).send({ message: 'Konto nicht gefunden.' })
        return
      }
      if (result.reason === 'rate_limited') {
        await reply
          .code(429)
          .header('retry-after', String(SYNC_REQUEST_MIN_INTERVAL_SECONDS))
          .send(result)
        return
      }
      // 202: queued for the worker; 200: nothing to do (reason says why).
      await reply.code(result.queued ? 202 : 200).send(result)
    },
  )

  // All accounts at once (app start/focus): rate-limited accounts are
  // simply reported, the request itself always succeeds.
  app.post('/api/sync', { onRequest: requireAuth }, async (request, reply) => {
    const body: SyncAllResponse = {
      accounts: await requestSync(pool, request.auth!.userId, null),
    }
    await reply.send(body)
  })
}
