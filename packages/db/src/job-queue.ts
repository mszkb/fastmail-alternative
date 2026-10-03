/**
 * Minimal job queue on the `job` table (ADR-0003).
 *
 * - Workers claim jobs with SELECT ... FOR UPDATE SKIP LOCKED, so multiple
 *   workers never take the same job.
 * - Failures are retried with exponential backoff via run_at; after
 *   MAX_ATTEMPTS the job goes to state 'failed'.
 * - Payloads contain only ids; error messages are truncated (and should be
 *   redacted by callers, see @fma/shared redaction rules).
 */
import type pg from 'pg'

export const MAX_JOB_ATTEMPTS = 5
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 60 * 60_000

export interface Job {
  id: string
  type: string
  accountId: string | null
  payload: Record<string, unknown>
  attempts: number
}

export interface EnqueueOptions {
  type: string
  accountId?: string | null
  payload?: Record<string, unknown>
  /** Delay before the job becomes eligible (defaults to immediately). */
  runAt?: Date
}

export async function enqueueJob(pool: pg.Pool, options: EnqueueOptions): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job (type, account_id, payload, run_at)
     VALUES ($1, $2, $3, COALESCE($4, now())) RETURNING id`,
    [options.type, options.accountId ?? null, options.payload ?? {}, options.runAt ?? null],
  )
  const id = rows[0]?.id
  if (!id) throw new Error('job insert returned no id')
  return String(id)
}

/**
 * Atomically claims the oldest queued job of the given types. Returns null
 * when no job is eligible. The claimed job is marked 'running' and its
 * attempt counter incremented.
 */
export async function claimNextJob(pool: pg.Pool, types: string[]): Promise<Job | null> {
  if (types.length === 0) return null
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, type, account_id, payload, attempts FROM job
       WHERE state = 'queued' AND run_at <= now() AND type = ANY($1)
       ORDER BY run_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [types],
    )
    const row = rows[0]
    if (!row) {
      await client.query('ROLLBACK')
      return null
    }
    await client.query(
      `UPDATE job SET state = 'running', locked_at = now(), attempts = attempts + 1
       WHERE id = $1`,
      [row.id],
    )
    await client.query('COMMIT')
    return {
      id: String(row.id),
      type: String(row.type),
      accountId: row.account_id ? String(row.account_id) : null,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      attempts: Number(row.attempts) + 1,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function completeJob(pool: pg.Pool, jobId: string): Promise<void> {
  await pool.query(`UPDATE job SET state = 'done', last_error = NULL WHERE id = $1`, [jobId])
}

/**
 * Marks a job as failed: retried with exponential backoff while attempts
 * remain, otherwise moved to state 'failed' (terminal, visible for ops).
 */
export async function failJob(
  pool: pg.Pool,
  jobId: string,
  attempts: number,
  errorMessage: string,
): Promise<void> {
  // Redact + truncate: error strings may reference user content.
  const safeError = errorMessage.slice(0, 500)
  if (attempts >= MAX_JOB_ATTEMPTS) {
    await pool.query(`UPDATE job SET state = 'failed', last_error = $2 WHERE id = $1`, [
      jobId,
      safeError,
    ])
    return
  }
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS)
  await pool.query(
    `UPDATE job SET state = 'queued', run_at = now() + ($2 || ' milliseconds')::interval,
       last_error = $3
     WHERE id = $1`,
    [jobId, String(backoff), safeError],
  )
}
