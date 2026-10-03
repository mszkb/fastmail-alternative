/**
 * Worker entrypoint (roadmap 2.2): polls the job table and dispatches jobs.
 *
 * Long-running IMAP IDLE connections are NOT queue jobs (ADR-0003); they are
 * worker-managed connections added in a later step. This loop only processes
 * short-lived jobs (folder sync, later: message sync, send, push, cleanup).
 *
 * Logging: structured JSON via pino with the central redaction rules
 * (roadmap 1.7).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { claimNextJob, completeJob, enqueueJob, failJob } from '@fma/db/job-queue'
import { runMigrations } from '@fma/db/migrate'
import { createPool, type Pool } from '@fma/db'
import { runFolderSync } from './jobs/folder-sync'
import { runMessageSync } from './jobs/message-sync'
import { log } from './log'

const POLL_INTERVAL_MS = 2_000
/** Job types this worker instance processes. */
const JOB_TYPES = ['folder_sync', 'message_sync']

let shuttingDown = false

async function processJob(
  pool: Pool,
  job: {
    id: string
    type: string
    accountId: string | null
    payload: Record<string, unknown>
    attempts: number
  },
): Promise<void> {
  const jobId = job.id
  const type = job.type
  const accountId = job.accountId
  switch (type) {
    case 'folder_sync': {
      if (!accountId) throw new Error('folder_sync job without account_id')
      await runFolderSync(pool, accountId)
      // Chain: one message_sync job per synced folder.
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM folder WHERE account_id = $1',
        [accountId],
      )
      for (const row of rows) {
        await enqueueJob(pool, {
          type: 'message_sync',
          accountId,
          payload: { folderId: String(row.id) },
        })
      }
      await completeJob(pool, jobId)
      log.info({ jobId, accountId }, 'folder_sync done')
      break
    }
    case 'message_sync': {
      if (!accountId) throw new Error('message_sync job without account_id')
      const folderId = typeof job.payload.folderId === 'string' ? job.payload.folderId : null
      if (!folderId) throw new Error('message_sync job without folder_id')
      await runMessageSync(pool, accountId, folderId)
      await completeJob(pool, jobId)
      log.info({ jobId, accountId, folderId }, 'message_sync done')
      break
    }
    default:
      // Unknown type: complete it, otherwise it would retry forever.
      log.warn({ jobId, type }, 'unknown job type, marking done')
      await completeJob(pool, jobId)
  }
}

async function main(): Promise<void> {
  const pool = createPool()
  const applied = await runMigrations(pool)
  if (applied.length > 0) {
    log.info({ applied }, 'migrations applied')
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down after current job')
      shuttingDown = true
    })
  }

  // Catch-up: make sure every account has at least one folder_sync queued
  // (covers accounts created while the worker was down).
  await pool.query(
    `INSERT INTO job (type, account_id)
     SELECT 'folder_sync', id FROM mail_account ma
     WHERE NOT EXISTS (
       SELECT 1 FROM job j
       WHERE j.type = 'folder_sync' AND j.account_id = ma.id
         AND j.state IN ('queued', 'running')
     )`,
  )

  log.info({ jobTypes: JOB_TYPES }, 'worker started')

  while (!shuttingDown) {
    let job: Awaited<ReturnType<typeof claimNextJob>> = null
    try {
      job = await claimNextJob(pool, JOB_TYPES)
    } catch (err) {
      log.error({ err: (err as Error).message }, 'claim failed')
    }

    if (!job) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    log.info(
      { jobId: job.id, type: job.type, accountId: job.accountId, attempts: job.attempts },
      'job started',
    )
    try {
      await processJob(pool, job)
    } catch (err) {
      const error = err as Error & { response?: string; code?: string }
      const message = error.message ?? String(err)
      await failJob(pool, job.id, job.attempts, message).catch((dbErr) => {
        log.error({ err: dbErr.message }, 'failJob failed')
      })
      log.warn(
        {
          jobId: job.id,
          type: job.type,
          err: message,
          imapResponse: error.response,
          imapCode: error.code,
          stack: error.stack,
        },
        'job failed',
      )
    }
  }

  log.info('worker stopped')
  await pool.end().catch(() => {})
}

main().catch((err) => {
  log.error({ err: (err as Error).stack ?? String(err) }, 'worker crashed')
  process.exit(1)
})
