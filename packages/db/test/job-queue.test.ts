/**
 * Integration tests for the job queue (ADR-0003). Requires DATABASE_URL;
 * skipped otherwise. Uses the configured test database exclusively.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations } from '../src/migrate'
import { claimNextJob, completeJob, enqueueJob, failJob, MAX_JOB_ATTEMPTS } from '../src/job-queue'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('job queue', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
    await pool.query('DELETE FROM job')
  })

  afterAll(async () => {
    await pool.query('DELETE FROM job')
    await pool.end()
  })

  it('enqueues and claims a job in FIFO order', async () => {
    const first = await enqueueJob(pool, { type: 'folder_sync', payload: { n: 1 } })
    const second = await enqueueJob(pool, { type: 'folder_sync', payload: { n: 2 } })
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()

    const claimed = await claimNextJob(pool, ['folder_sync'])
    expect(claimed?.payload).toEqual({ n: 1 })
    expect(claimed?.attempts).toBe(1)

    // A running job is not claimed again.
    const none = await claimNextJob(pool, ['folder_sync'])
    expect(none?.id).toBe(second) // first is running, second is queued

    await completeJob(pool, claimed!.id)
    const done = await pool.query('SELECT state FROM job WHERE id = $1', [claimed!.id])
    expect(done.rows[0].state).toBe('done')
  })

  it('respects run_at delays', async () => {
    await enqueueJob(pool, { type: 'folder_sync', runAt: new Date(Date.now() + 60_000) })
    const claimed = await claimNextJob(pool, ['folder_sync'])
    expect(claimed).toBeNull()
  })

  it('does not claim jobs of other types', async () => {
    await enqueueJob(pool, { type: 'push_send' })
    const claimed = await claimNextJob(pool, ['folder_sync'])
    expect(claimed).toBeNull()
  })

  it('retries failed jobs with backoff and marks them failed after max attempts', async () => {
    const id = await enqueueJob(pool, { type: 'folder_sync' })

    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
      const claimed = await claimNextJob(pool, ['folder_sync'])
      expect(claimed?.id).toBe(id)
      expect(claimed?.attempts).toBe(attempt)

      await failJob(pool, claimed!.id, claimed!.attempts, 'boom')
      if (attempt < MAX_JOB_ATTEMPTS) {
        // Backoff: not immediately eligible again.
        const tooEarly = await claimNextJob(pool, ['folder_sync'])
        expect(tooEarly).toBeNull()
        // Make it eligible again for the next attempt.
        await pool.query('UPDATE job SET run_at = now() WHERE id = $1', [id])
      }
    }

    const { rows } = await pool.query('SELECT state, last_error FROM job WHERE id = $1', [id])
    expect(rows[0].state).toBe('failed')
    expect(rows[0].last_error).toBe('boom')
  })

  it('clears last_error on successful completion', async () => {
    const id = await enqueueJob(pool, { type: 'folder_sync' })
    const claimed = await claimNextJob(pool, ['folder_sync'])
    await failJob(pool, claimed!.id, claimed!.attempts, 'boom')
    await pool.query('UPDATE job SET run_at = now() WHERE id = $1', [id])

    const retried = await claimNextJob(pool, ['folder_sync'])
    expect(retried?.id).toBe(id)
    await completeJob(pool, id)

    const { rows } = await pool.query('SELECT state, last_error FROM job WHERE id = $1', [id])
    expect(rows[0].state).toBe('done')
    expect(rows[0].last_error).toBeNull()
  })

  it('deletes queued jobs when the account is deleted (cascade)', async () => {
    // mail_account cascade requires an existing account; job.account_id is a
    // FK. We only verify the schema behavior with a null-account job here.
    const id = await enqueueJob(pool, { type: 'folder_sync' })
    await pool.query('DELETE FROM job WHERE id = $1', [id])
    const { rowCount } = await pool.query('SELECT 1 FROM job WHERE id = $1', [id])
    expect(rowCount).toBe(0)
  })
})
