/**
 * Worker entrypoint (roadmap 2.2): runs the scheduler and the job runner.
 *
 * Long-running IMAP IDLE connections are NOT queue jobs (ADR-0003); they are
 * worker-managed connections added in a later step. The runner (./runner)
 * only processes short-lived jobs (folder sync, message sync, message
 * actions, SMTP send, account cleanup, push, periodic cleanup), several in parallel
 * but at most one per account, each with a hard timeout (roadmap 3.4).
 * Until IDLE exists, the scheduler (./scheduler) enqueues a periodic
 * folder_sync per account so new mail appears without reload.
 *
 * Logging: structured JSON via pino with the central redaction rules
 * (roadmap 1.7).
 */
import { runMigrations } from '@fma/db/migrate'
import { createPool } from '@fma/db'
import { markSendGivenUp } from './jobs/send-message'
import { log } from './log'
import { JOB_TYPES, JobRunner, workerConcurrency } from './runner'
import { cleanupIntervalSeconds } from './jobs/cleanup'
import {
  enqueueDueCleanup,
  enqueueDueSyncs,
  requeueStaleJobs,
  syncIntervalSeconds,
} from './scheduler'

const POLL_INTERVAL_MS = 2_000
/** How often the scheduler checks for due accounts (cheap single query). */
const SCHEDULER_TICK_MS = 15_000

let shuttingDown = false

async function main(): Promise<void> {
  const pool = createPool()
  const applied = await runMigrations(pool)
  if (applied.length > 0) {
    log.info({ applied }, 'migrations applied')
  }

  // A lost job that used up its attempts: make a failed send visible.
  const giveUp = async (job: { type: string; payload: Record<string, unknown> }) => {
    if (job.type === 'send_message') await markSendGivenUp(pool, job.payload)
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'shutting down after running jobs')
      shuttingDown = true
    })
  }

  // Crash recovery: jobs still 'running' belong to a previous worker process
  // (single instance) - requeue them now instead of blocking their accounts
  // until they count as stale.
  const recovered = await requeueStaleJobs(pool, 0, giveUp)
  if (recovered.requeued + recovered.failed > 0) log.warn(recovered, 'lost running jobs recovered')

  // Periodic sync. The first tick runs immediately and also covers accounts
  // created while the worker was down.
  const intervalSeconds = syncIntervalSeconds()
  const cleanupInterval = cleanupIntervalSeconds()
  let nextSchedulerTick = 0
  const schedulerTick = async (): Promise<void> => {
    if (Date.now() < nextSchedulerTick) return
    nextSchedulerTick = Date.now() + SCHEDULER_TICK_MS
    try {
      const stale = await requeueStaleJobs(pool, undefined, giveUp)
      if (stale.requeued + stale.failed > 0) log.warn(stale, 'stale running jobs recovered')
      const accountIds = await enqueueDueSyncs(pool, intervalSeconds)
      if (accountIds.length > 0) log.info({ accountIds }, 'periodic sync enqueued')
      if (await enqueueDueCleanup(pool, cleanupInterval)) log.info('cleanup enqueued')
    } catch (err) {
      log.error({ err: (err as Error).message }, 'scheduler tick failed')
    }
  }

  const concurrency = workerConcurrency()
  const runner = new JobRunner(pool, { concurrency })
  log.info(
    { jobTypes: JOB_TYPES, concurrency, syncIntervalSeconds: intervalSeconds },
    'worker started',
  )

  while (!shuttingDown) {
    await schedulerTick()
    await runner.fill()
    // Wake up when a slot frees up, at the latest after the poll interval.
    await runner.waitForSlot(POLL_INTERVAL_MS)
  }

  await runner.stop()
  log.info('worker stopped')
  await pool.end().catch(() => {})
}

main().catch((err) => {
  log.error({ err: (err as Error).stack ?? String(err) }, 'worker crashed')
  process.exit(1)
})
