/**
 * Job runner (roadmap 2.2, 3.4): claims jobs from the job table and runs up
 * to `concurrency` of them in parallel, isolated per account.
 *
 * - At most one running job per account (job claim + in-process busy set),
 *   so a slow or hanging provider occupies at most one slot and the other
 *   accounts keep syncing.
 * - Hard timeout per job type: the job is aborted (its provider connections
 *   are closed, see ./job-context), failed with backoff and its slot freed.
 *   The account stays busy until the aborted job has really settled.
 * - Connection-level errors update the account health (circuit breaker,
 *   ./account-health); a successful sync closes the circuit.
 * - At most `maxConnectionsPerHost` running account jobs per IMAP host
 *   (roadmap 3.5, IMAP_MAX_CONNECTIONS_PER_HOST): several accounts at the
 *   same provider never open more parallel job connections than the
 *   provider allows. Jobs of a saturated host simply stay queued and are
 *   claimed once a slot of that host frees up (no waiting in a slot).
 *   IMAP IDLE connections (./idle) are not counted here: they are bounded
 *   separately (one per account, IMAP_IDLE_MAX_CONNECTIONS).
 * - Priority types (user actions, sending) are claimed before syncs.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { MAX_JOB_ATTEMPTS, claimNextJob, completeJob, failJob, type Job } from '@fma/db/job-queue'
import type { Pool } from '@fma/db'
import {
  JobTimeoutError,
  classifyAccountError,
  recordAccountFailure,
  recordAccountSuccess,
} from './account-health'
import { runWithJobSignal } from './job-context'
import { runAccountCleanup } from './jobs/account-cleanup'
import { runCleanup } from './jobs/cleanup'
import { runDraftSync } from './jobs/draft-sync'
import { runFolderSync } from './jobs/folder-sync'
import { runMessageAction } from './jobs/message-action'
import { runMessageSync } from './jobs/message-sync'
import { runPushNotify } from './jobs/push-notify'
import { markSendGivenUp, runSendMessage } from './jobs/send-message'
import { log } from './log'
import { enqueueMessageSync } from './scheduler'

/** Job types this worker processes. */
export const JOB_TYPES = [
  'folder_sync',
  'message_sync',
  'message_action',
  'send_message',
  'draft_sync',
  'account_cleanup',
  'push_notify',
  'cleanup',
]
/**
 * Claimed before all other types: user actions are small and interactive,
 * and writing them back before the next sync keeps the sync from briefly
 * reverting optimistic changes (see jobs/message-action). Sending is
 * user-facing too and must not wait behind a long initial sync, and so is
 * mirroring drafts (small, removes the copy of a sent draft promptly).
 */
export const PRIORITY_JOB_TYPES = ['message_action', 'send_message', 'draft_sync']

const DEFAULT_CONCURRENCY = 4
const DEFAULT_MAX_CONNECTIONS_PER_HOST = 4
/** Hard timeout per job type; message_sync covers a bounded initial sync. */
const JOB_TIMEOUT_MS: Record<string, number> = {
  folder_sync: 3 * 60_000,
  message_sync: 15 * 60_000,
  message_action: 3 * 60_000,
  send_message: 5 * 60_000,
  draft_sync: 2 * 60_000,
  account_cleanup: 5 * 60_000,
  push_notify: 2 * 60_000,
  cleanup: 10 * 60_000,
}
const FALLBACK_TIMEOUT_MS = 5 * 60_000

/** Parallel job slots from WORKER_CONCURRENCY (default 4). */
export function workerConcurrency(): number {
  const value = Number(process.env.WORKER_CONCURRENCY)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY
}

/**
 * Parallel job connections per IMAP host from IMAP_MAX_CONNECTIONS_PER_HOST
 * (default 4; invalid values fall back to the default).
 */
export function imapMaxConnectionsPerHost(): number {
  const value = Number(process.env.IMAP_MAX_CONNECTIONS_PER_HOST)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CONNECTIONS_PER_HOST
}

export function jobTimeoutMs(type: string): number {
  return JOB_TIMEOUT_MS[type] ?? FALLBACK_TIMEOUT_MS
}

/** Runs one job's work; reports account-level outcomes via `health`. */
async function processJob(
  pool: Pool,
  job: Job,
  health: { synced: boolean; failure: unknown },
): Promise<void> {
  const { id: jobId, type, accountId } = job
  switch (type) {
    case 'folder_sync': {
      if (!accountId) throw new Error('folder_sync job without account_id')
      await runFolderSync(pool, accountId)
      health.synced = true
      // Chain: one message_sync job per selectable folder (deduplicated).
      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM folder WHERE account_id = $1 AND selectable',
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
      const loadOlder = job.payload.loadOlder === true
      await runMessageSync(pool, accountId, folderId, undefined, { loadOlder })
      health.synced = true
      await completeJob(pool, jobId)
      log.info({ jobId, accountId, folderId, loadOlder }, 'message_sync done')
      break
    }
    case 'message_action': {
      if (!accountId) throw new Error('message_action job without account_id')
      const outcome = await runMessageAction(pool, accountId, job.payload)
      await completeJob(pool, jobId)
      log.info({ jobId, accountId, outcome }, 'message_action done')
      break
    }
    case 'send_message': {
      if (!accountId) throw new Error('send_message job without account_id')
      const outcome = await runSendMessage(pool, accountId, job.payload, {
        attempt: job.attempts,
        maxAttempts: MAX_JOB_ATTEMPTS,
        onFailed: (code) => {
          health.failure = { code }
        },
      })
      await completeJob(pool, jobId)
      log.info({ jobId, accountId, outcome }, 'send_message done')
      break
    }
    case 'draft_sync': {
      if (!accountId) throw new Error('draft_sync job without account_id')
      const outcome = await runDraftSync(pool, accountId, job.payload)
      await completeJob(pool, jobId)
      log.info({ jobId, accountId, outcome }, 'draft_sync done')
      break
    }
    case 'account_cleanup': {
      const outcome = await runAccountCleanup(pool, job.payload)
      await completeJob(pool, jobId)
      log.info({ jobId, outcome }, 'account_cleanup done')
      break
    }
    case 'push_notify': {
      const outcome = await runPushNotify(pool, job.payload)
      await completeJob(pool, jobId)
      log.info({ jobId, outcome }, 'push_notify done')
      break
    }
    case 'cleanup': {
      // Counters only, never content.
      const outcome = await runCleanup(pool)
      await completeJob(pool, jobId)
      log.info({ jobId, ...outcome }, 'cleanup done')
      break
    }
    default:
      // Unknown type: complete it, otherwise it would retry forever.
      log.warn({ jobId, type }, 'unknown job type, marking done')
      await completeJob(pool, jobId)
  }
}

/** Updates the account status after a job (errors here never fail the job). */
async function updateHealth(
  pool: Pool,
  job: Job,
  health: { synced: boolean; failure: unknown },
): Promise<void> {
  if (!job.accountId) return
  try {
    const accountError = health.failure ? classifyAccountError(health.failure) : null
    if (accountError) {
      const state = await recordAccountFailure(pool, job.accountId, accountError)
      log.warn(
        { accountId: job.accountId, type: job.type, code: accountError.code, ...state },
        'account connection failed',
      )
    } else if (health.synced) {
      await recordAccountSuccess(pool, job.accountId)
    }
  } catch (err) {
    log.error({ err: (err as Error).message, accountId: job.accountId }, 'health update failed')
  }
}

export interface JobRunnerOptions {
  concurrency?: number
  /** Running account jobs per IMAP host (default IMAP_MAX_CONNECTIONS_PER_HOST). */
  maxConnectionsPerHost?: number
  /** Hard timeout per job type (tests use short ones). */
  timeoutMs?: (type: string) => number
}

export class JobRunner {
  private readonly slots = new Set<Promise<void>>()
  /** Accounts with a job whose work has not settled yet (incl. timed out). */
  private readonly busyAccounts = new Set<string>()
  /** Unsettled account jobs per IMAP host (lower-cased). */
  private readonly hostJobs = new Map<string, number>()
  private readonly concurrency: number
  private readonly maxConnectionsPerHost: number
  private readonly timeoutMs: (type: string) => number

  constructor(
    private readonly pool: Pool,
    options: JobRunnerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? workerConcurrency()
    this.maxConnectionsPerHost = options.maxConnectionsPerHost ?? imapMaxConnectionsPerHost()
    this.timeoutMs = options.timeoutMs ?? jobTimeoutMs
  }

  get active(): number {
    return this.slots.size
  }

  /** Claims and starts jobs until all slots are busy or nothing is eligible. */
  async fill(): Promise<number> {
    let started = 0
    while (this.slots.size < this.concurrency) {
      let job: Job | null = null
      try {
        const exclude = {
          excludeAccountIds: [...this.busyAccounts, ...(await this.saturatedHostAccounts())],
        }
        job =
          (await claimNextJob(this.pool, PRIORITY_JOB_TYPES, exclude)) ??
          (await claimNextJob(this.pool, JOB_TYPES, exclude))
      } catch (err) {
        log.error({ err: (err as Error).message }, 'claim failed')
      }
      if (!job) break
      await this.start(job)
      started++
    }
    return started
  }

  /** Resolves when a slot frees up, or after `maxWaitMs`. */
  async waitForSlot(maxWaitMs: number): Promise<void> {
    if (this.slots.size === 0) {
      await sleep(maxWaitMs)
      return
    }
    await Promise.race([...this.slots, sleep(maxWaitMs)])
  }

  /** Runs jobs until nothing is eligible and nothing is running (tests, shutdown). */
  async drain(): Promise<void> {
    for (;;) {
      await this.fill()
      if (this.slots.size === 0) return
      await Promise.race(this.slots)
    }
  }

  /** Waits for all running jobs (graceful shutdown). */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.slots])
  }

  /** Number of unsettled account jobs per IMAP host (tests, diagnostics). */
  hostJobCounts(): Map<string, number> {
    return new Map(this.hostJobs)
  }

  /** Accounts whose IMAP host has no free connection slot. */
  private async saturatedHostAccounts(): Promise<string[]> {
    const hosts = [...this.hostJobs]
      .filter(([, count]) => count >= this.maxConnectionsPerHost)
      .map(([host]) => host)
    if (hosts.length === 0) return []
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM mail_account WHERE lower(imap_host) = ANY($1)',
      [hosts],
    )
    return rows.map((row) => String(row.id))
  }

  private async imapHostOf(accountId: string): Promise<string | null> {
    try {
      const { rows } = await this.pool.query<{ host: string }>(
        'SELECT lower(imap_host) AS host FROM mail_account WHERE id = $1',
        [accountId],
      )
      return rows[0]?.host ?? null
    } catch {
      return null
    }
  }

  private async start(job: Job): Promise<void> {
    // Reserve the host slot before the next claim (fill() is sequential).
    const host = job.accountId ? await this.imapHostOf(job.accountId) : null
    if (host) this.hostJobs.set(host, (this.hostJobs.get(host) ?? 0) + 1)
    const slot = this.execute(job, host).finally(() => {
      this.slots.delete(slot)
    })
    this.slots.add(slot)
  }

  private async execute(job: Job, host: string | null): Promise<void> {
    log.info(
      { jobId: job.id, type: job.type, accountId: job.accountId, attempts: job.attempts },
      'job started',
    )
    const health = { synced: false, failure: undefined as unknown }
    const controller = new AbortController()
    const work = runWithJobSignal(controller.signal, () => processJob(this.pool, job, health))

    const accountId = job.accountId
    if (accountId) {
      this.busyAccounts.add(accountId)
      work
        .catch(() => {})
        .finally(() => {
          this.busyAccounts.delete(accountId)
          if (host) this.releaseHost(host)
        })
    }

    const timeoutMs = this.timeoutMs(job.type)
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new JobTimeoutError(job.type, timeoutMs))
      }, timeoutMs)
    })

    try {
      await Promise.race([work, timeout])
    } catch (err) {
      health.failure = err
      await this.fail(job, err)
    } finally {
      clearTimeout(timer)
    }
    await updateHealth(this.pool, job, health)
  }

  private releaseHost(host: string): void {
    const count = (this.hostJobs.get(host) ?? 1) - 1
    if (count > 0) this.hostJobs.set(host, count)
    else this.hostJobs.delete(host)
  }

  private async fail(job: Job, err: unknown): Promise<void> {
    const summary = describeJobError(err)
    await failJob(this.pool, job.id, job.attempts, summary.text).catch((dbErr: Error) => {
      log.error({ err: dbErr.message }, 'failJob failed')
    })
    if (job.type === 'send_message' && job.attempts >= MAX_JOB_ATTEMPTS) {
      // Unexpected error on the last attempt: make the failure visible.
      await markSendGivenUp(this.pool, job.payload).catch((dbErr: Error) => {
        log.error({ err: dbErr.message }, 'markSendGivenUp failed')
      })
    }
    log.warn(
      {
        jobId: job.id,
        type: job.type,
        accountId: job.accountId,
        errName: summary.name,
        errCode: summary.code,
        accountErrorCode: summary.accountErrorCode,
        stack: summary.frames,
      },
      'job failed',
    )
  }
}

/**
 * Content-free description of a job error. Error messages and server
 * responses (IMAP/SMTP) can echo addresses, mailbox names or subjects, so
 * neither ends up in logs or in job.last_error (CLAUDE.md rule 6); only the
 * error class, its code and the stack frames (without the message line) do.
 */
export function describeJobError(err: unknown): {
  name: string
  code: string | undefined
  accountErrorCode: string | undefined
  frames: string | undefined
  text: string
} {
  const error = (err && typeof err === 'object' ? err : {}) as {
    name?: unknown
    code?: unknown
    stack?: unknown
  }
  const name = typeof error.name === 'string' ? error.name : typeof err
  const code = typeof error.code === 'string' ? error.code : undefined
  const accountErrorCode = classifyAccountError(err)?.code
  const frames =
    typeof error.stack === 'string'
      ? error.stack
          .split('\n')
          .filter((line) => line.trimStart().startsWith('at '))
          .join('\n') || undefined
      : undefined
  const text = [name, code, accountErrorCode].filter(Boolean).join(':')
  return { name, code, accountErrorCode, frames, text }
}
