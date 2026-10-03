/**
 * Tests for the periodic sync scheduler (roadmap 2.2). Requires
 * DATABASE_URL (no IMAP needed: only job rows are inspected).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { runMigrations } from '@fma/db/migrate'
import { claimNextJob, failJob } from '@fma/db/job-queue'
import { enqueueDueSyncs, enqueueMessageSync, requeueStaleJobs } from '../src/scheduler'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('sync scheduler', () => {
  let pool: pg.Pool
  let userId: string

  async function createAccount(status = 'ok'): Promise<string> {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
       VALUES ($1, $2, 'Sched', 'sched@example.com', 'imap.test', 993,
         'smtp.test', 465, '\\x00', 'v1', '\\x00', $3)`,
      [id, userId, status],
    )
    return id
  }

  async function folderSyncJobs(accountId: string): Promise<{ state: string }[]> {
    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM job WHERE type = 'folder_sync' AND account_id = $1 ORDER BY id`,
      [accountId],
    )
    return rows
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE session, device, "user", mail_account, identity, folder, job, message, message_location, message_body CASCADE',
    )
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`sched-${Date.now()}@example.com`],
    )
    userId = user.rows[0]!.id
  })

  afterAll(async () => {
    await pool.query('TRUNCATE "user", mail_account, job CASCADE')
    await pool.end()
  })

  it('enqueues one folder_sync per active account and no duplicates', async () => {
    const a = await createAccount()
    const b = await createAccount()
    await createAccount('disabled')

    const first = await enqueueDueSyncs(pool, 120)
    expect(first.sort()).toEqual([a, b].sort())

    // Repeated ticks while the job is queued, then running: no pile-up.
    expect(await enqueueDueSyncs(pool, 120)).toEqual([])
    const job = await claimNextJob(pool, ['folder_sync'])
    expect(job).not.toBeNull()
    expect(await enqueueDueSyncs(pool, 120)).toEqual([])
    expect(await folderSyncJobs(a)).toHaveLength(1)
    expect(await folderSyncJobs(b)).toHaveLength(1)
  })

  it('waits for the interval after a finished sync', async () => {
    const a = await createAccount()
    await enqueueDueSyncs(pool, 120)
    await pool.query(`UPDATE job SET state = 'done' WHERE account_id = $1`, [a])

    // Done just now: not due yet.
    expect(await enqueueDueSyncs(pool, 120)).toEqual([])

    // Interval elapsed: due again.
    await pool.query(
      `UPDATE job SET created_at = now() - interval '3 minutes' WHERE account_id = $1`,
      [a],
    )
    expect(await enqueueDueSyncs(pool, 120)).toEqual([a])
  })

  it('respects backoff of a failing job and isolates accounts', async () => {
    const broken = await createAccount()
    const healthy = await createAccount()
    await enqueueDueSyncs(pool, 120)

    // The broken account's job fails and is re-queued with backoff.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text FROM job WHERE account_id = $1`,
      [broken],
    )
    await failJob(pool, rows[0]!.id, 1, 'auth failed')
    await pool.query(
      `UPDATE job SET state = 'done', created_at = now() - interval '1 hour'
      WHERE account_id = $1`,
      [healthy],
    )

    // Healthy account is due again; the broken one keeps its backoff job.
    expect(await enqueueDueSyncs(pool, 120)).toEqual([healthy])
    expect(await folderSyncJobs(broken)).toEqual([{ state: 'queued' }])

    // Terminal failure: retried only after the long failure interval.
    await pool.query(
      `UPDATE job SET state = 'failed', created_at = now() - interval '10 minutes'
      WHERE account_id = $1`,
      [broken],
    )
    expect(await enqueueDueSyncs(pool, 120)).toEqual([])
    await pool.query(
      `UPDATE job SET created_at = now() - interval '2 hours'
      WHERE account_id = $1`,
      [broken],
    )
    expect(await enqueueDueSyncs(pool, 120)).toEqual([broken])
  })

  it('deduplicates message_sync per folder', async () => {
    const a = await createAccount()
    const folderId = randomUUID()
    expect(await enqueueMessageSync(pool, a, folderId)).toBe(true)
    expect(await enqueueMessageSync(pool, a, folderId)).toBe(false)
    expect(await enqueueMessageSync(pool, a, randomUUID())).toBe(true)
  })

  it('requeues jobs stuck in running', async () => {
    const a = await createAccount()
    await enqueueDueSyncs(pool, 120)
    await claimNextJob(pool, ['folder_sync'])
    expect(await requeueStaleJobs(pool)).toBe(0)
    await pool.query(
      `UPDATE job SET locked_at = now() - interval '2 hours' WHERE account_id = $1`,
      [a],
    )
    expect(await requeueStaleJobs(pool)).toBe(1)
    expect(await folderSyncJobs(a)).toEqual([{ state: 'queued' }])
  })
})
