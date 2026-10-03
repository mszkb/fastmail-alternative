/**
 * Worker entrypoint (roadmap 2.2): polls the job table and dispatches jobs.
 *
 * Long-running IMAP IDLE connections are NOT queue jobs (ADR-0003); they are
 * worker-managed connections added in a later step. This loop only processes
 * short-lived jobs (folder sync, message sync, message actions, later: send,
 * push, cleanup).
 * Until IDLE exists, the scheduler (./scheduler) enqueues a periodic
 * folder_sync per account so new mail appears without reload.
 *
 * Logging: structured JSON via pino with the central redaction rules
 * (roadmap 1.7).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { claimNextJob, completeJob, failJob } from '@fma/db/job-queue'
import { runMigrations } from '@fma/db/migrate'
import { createPool, type Pool } from '@fma/db'
import { runFolderSync } from './jobs/folder-sync'
import { runMessageAction } from './jobs/message-action'
import { runMessageSync } from './jobs/message-sync'
import { log } from './log'
import {
  enqueueDueSyncs,
  enqueueMessageSync,
  requeueStaleJobs,
  syncIntervalSeconds,
} from './scheduler'

const POLL_INTERVAL_MS = 2_000
/** How often the scheduler checks for due accounts (cheap single query). */
const SCHEDULER_TICK_MS = 15_000
/** Job types this worker instance processes. */
const JOB_TYPES = ['folder_sync', 'message_sync', 'message_action']
/**
 * Claimed before all other types: user actions are small and interactive,
 * and writing them back before the next sync keeps the sync from briefly
 * reverting optimistic changes (see jobs/message-action).
 */
const PRIORITY_JOB_TYPES = ['message_action']

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
      // Chain: one message_sync job per synced folder (deduplicated).
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM folder WHERE account_id = $1',
        [accountId],
      )
      for (const row of rows) {
        await enqueueMessageSync(pool, accountId, String(row.id))
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
    case 'message_action': {
      if (!accountId) throw new Error('message_action job without account_id')
      const outcome = await runMessageAction(pool, accountId, job.payload)
      await completeJob(pool, jobId)
      log.info({ jobId, accountId, outcome }, 'message_action done')
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

  // Periodic sync. The first tick runs immediately and also covers accounts
  // created while the worker was down.
  const intervalSeconds = syncIntervalSeconds()
  let nextSchedulerTick = 0
  const schedulerTick = async (): Promise<void> => {
    if (Date.now() < nextSchedulerTick) return
    nextSchedulerTick = Date.now() + SCHEDULER_TICK_MS
    try {
      const requeued = await requeueStaleJobs(pool)
      if (requeued > 0) log.warn({ requeued }, 'stale running jobs requeued')
      const accountIds = await enqueueDueSyncs(pool, intervalSeconds)
      if (accountIds.length > 0) log.info({ accountIds }, 'periodic sync enqueued')
    } catch (err) {
      log.error({ err: (err as Error).message }, 'scheduler tick failed')
    }
  }

  log.info({ jobTypes: JOB_TYPES, syncIntervalSeconds: intervalSeconds }, 'worker started')

  while (!shuttingDown) {
    await schedulerTick()

    let job: Awaited<ReturnType<typeof claimNextJob>> = null
    try {
      job = (await claimNextJob(pool, PRIORITY_JOB_TYPES)) ?? (await claimNextJob(pool, JOB_TYPES))
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
