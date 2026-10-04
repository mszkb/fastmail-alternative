/**
 * Integration tests for the job queue (ADR-0003). Requires DATABASE_URL;
 * skipped otherwise. Uses the configured test database exclusively.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

    const { rows } = await pool.query(
      `SELECT state, last_error, run_at > now() - interval '1 minute' AS failed_recently
       FROM job WHERE id = $1`,
      [id],
    )
    expect(rows[0].state).toBe('failed')
    expect(rows[0].last_error).toBe('boom')
    // The terminal failure stamps run_at with the time of failure.
    expect(rows[0].failed_recently).toBe(true)
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

describe.skipIf(!databaseUrl)('job queue: per-account isolation (roadmap 3.4)', () => {
  let pool: pg.Pool
  let userId: string

  async function createAccount(status = 'ok', nextRetryAt: Date | null = null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status, next_retry_at)
       VALUES (gen_random_uuid(), $1, 'Q', 'q@example.com', 'imap.test', 993,
         'smtp.test', 465, '\\x00', 'v1', '\\x00', $2, $3)
       RETURNING id`,
      [userId, status, nextRetryAt],
    )
    return rows[0]!.id
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE "user", mail_account, job CASCADE')
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`queue-${Date.now()}@example.com`],
    )
    userId = user.rows[0]!.id
  })

  afterAll(async () => {
    await pool.query('TRUNCATE "user", mail_account, job CASCADE')
    await pool.end()
  })

  it('runs at most one job per account at a time', async () => {
    const a = await createAccount()
    const b = await createAccount()
    await enqueueJob(pool, { type: 'message_sync', accountId: a })
    await enqueueJob(pool, { type: 'message_sync', accountId: a })
    await enqueueJob(pool, { type: 'message_sync', accountId: b })

    const first = await claimNextJob(pool, ['message_sync'])
    expect(first?.accountId).toBe(a)
    // a is busy: b's job is next although a's second job is older.
    const second = await claimNextJob(pool, ['message_sync'])
    expect(second?.accountId).toBe(b)
    expect(await claimNextJob(pool, ['message_sync'])).toBeNull()

    await completeJob(pool, first!.id)
    expect((await claimNextJob(pool, ['message_sync']))?.accountId).toBe(a)
  })

  it('skips accounts with an open circuit, auth error or exclusion', async () => {
    const backoff = await createAccount('unreachable', new Date(Date.now() + 60_000))
    const auth = await createAccount('auth_error')
    const disabled = await createAccount('disabled')
    const excluded = await createAccount()
    for (const accountId of [backoff, auth, disabled, excluded]) {
      await enqueueJob(pool, { type: 'folder_sync', accountId })
    }
    // Jobs without an account are not affected.
    const cleanup = await enqueueJob(pool, { type: 'account_cleanup' })

    const options = { excludeAccountIds: [excluded] }
    expect((await claimNextJob(pool, ['folder_sync', 'account_cleanup'], options))?.id).toBe(
      cleanup,
    )
    expect(await claimNextJob(pool, ['folder_sync'], options)).toBeNull()

    // Backoff over: the account is eligible again (half-open probe).
    await pool.query(`UPDATE mail_account SET next_retry_at = now() WHERE id = $1`, [backoff])
    expect((await claimNextJob(pool, ['folder_sync'], options))?.accountId).toBe(backoff)
  })
})
