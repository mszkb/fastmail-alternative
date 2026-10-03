/**
 * cleanup job (roadmap 5.5): periodic housekeeping, enqueued by the
 * scheduler every CLEANUP_INTERVAL_HOURS (./scheduler enqueueDueCleanup).
 *
 * Steps (each in small batches with LIMIT, no long transactions, stops
 * between batches when the job is aborted):
 * 1. Messages without any location (folder deleted on the provider, an
 *    interrupted UIDVALIDITY resync) incl. their encrypted raw file. Only
 *    for accounts without a running job and without a queued message_action
 *    (a sync may be relinking such messages; an expunge is pending).
 * 2. Attachment uploads never bound to a message (closed browser) after
 *    UPLOAD_RETENTION_HOURS; uploads of settled messages whose deletion was
 *    interrupted.
 * 3. Outbox entries: sent and settled ones (content already cleared) and
 *    failed ones the user did not retry, after OUTBOX_RETENTION_DAYS
 *    (their uploads cascade).
 * 4. Expired sessions; push subscriptions disabled for 30 days.
 * 5. Finished jobs after JOB_RETENTION_DAYS, failed ones after
 *    FAILED_JOB_RETENTION_DAYS. Queued and running jobs are never touched.
 * 6. Volume scan: message directories in mail-data without a message_body
 *    row pointing at them (crash between file write and DB commit) and
 *    directories of accounts that no longer exist - only when older than
 *    ORPHAN_FILE_GRACE_HOURS, so files of a running sync are safe. The scan
 *    streams the directories (opendir) and checks them in batches.
 *
 * Order: database rows first, files afterwards. A crash in between only
 * leaves unreferenced files, which step 6 finds later - never rows whose
 * file is missing.
 *
 * Logs carry counters only, never content (CLAUDE.md rules 5/6).
 */
import { opendir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from '@fma/db'
import { jobAborted } from '../job-context'
import { log } from '../log'
import { removeEmptyThreads } from '../threading'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BATCH_SIZE = 500
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
/** Disabled push subscriptions are kept this long (re-subscribe re-enables). */
const DISABLED_PUSH_RETENTION_MS = 30 * DAY_MS

export interface CleanupSettings {
  jobRetentionMs: number
  failedJobRetentionMs: number
  uploadRetentionMs: number
  outboxRetentionMs: number
  orphanFileGraceMs: number
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Settings from the environment (defaults: 7 d, 30 d, 7 d, 30 d, 24 h).
 * Uploads are kept 7 days so a message written offline with attachments
 * (offline queue, roadmap 4.6) can still be sent after a longer offline
 * phase; a later send answers ATTACHMENT_MISSING and keeps the text.
 */
export function cleanupSettings(): CleanupSettings {
  return {
    jobRetentionMs: positiveNumber('JOB_RETENTION_DAYS', 7) * DAY_MS,
    failedJobRetentionMs: positiveNumber('FAILED_JOB_RETENTION_DAYS', 30) * DAY_MS,
    uploadRetentionMs: positiveNumber('UPLOAD_RETENTION_HOURS', 7 * 24) * HOUR_MS,
    outboxRetentionMs: positiveNumber('OUTBOX_RETENTION_DAYS', 30) * DAY_MS,
    orphanFileGraceMs: positiveNumber('ORPHAN_FILE_GRACE_HOURS', 24) * HOUR_MS,
  }
}

/** Interval of the cleanup job from CLEANUP_INTERVAL_HOURS (default 6). */
export function cleanupIntervalSeconds(): number {
  return positiveNumber('CLEANUP_INTERVAL_HOURS', 6) * 3600
}

function mailDataDir(): string {
  return process.env.MAIL_DATA_DIR ?? '/app/mail-data'
}

/** Postgres interval parameter from milliseconds. */
function interval(ms: number): string {
  return `${Math.round(ms)} milliseconds`
}

/**
 * Removes the message directory of a storage_ref (<account>/<message>/raw.eml.enc);
 * never outside the volume root.
 */
async function removeMessageDir(root: string, storageRef: string): Promise<void> {
  const dir = path.resolve(root, path.dirname(storageRef))
  if (!dir.startsWith(root + path.sep)) return
  await rm(dir, { recursive: true, force: true })
}

/**
 * Deletes messages of an account that have no location left, in batches,
 * incl. their raw files (rows first, then files). Returns the count.
 *
 * `onlyWhenIdle`: skip (atomically, inside the DELETE) while the account
 * has a running job or a queued message_action - for callers that are not
 * themselves the account's running job. Jobs of the account itself
 * (folder_sync, message_sync) pass false: the runner allows only one
 * running job per account.
 */
export async function purgeLocationlessMessages(
  pool: Pool,
  accountId: string,
  onlyWhenIdle = false,
): Promise<number> {
  const root = path.resolve(mailDataDir())
  let total = 0
  for (;;) {
    const { rows } = await pool.query<{ id: string; storage_ref: string | null }>(
      `WITH orphan AS (
         SELECT m.id FROM message m
         WHERE m.account_id = $1
           AND NOT EXISTS (SELECT 1 FROM message_location ml WHERE ml.message_id = m.id)
           AND (NOT $3::boolean OR (
             NOT EXISTS (
               SELECT 1 FROM job j WHERE j.account_id = $1 AND j.state = 'running'
             )
             AND NOT EXISTS (
               SELECT 1 FROM job j
               WHERE j.account_id = $1 AND j.type = 'message_action' AND j.state = 'queued'
             )
           ))
         LIMIT $2
       ), refs AS (
         SELECT mb.message_id, mb.storage_ref FROM message_body mb
         JOIN orphan o ON o.id = mb.message_id
       )
       DELETE FROM message m USING orphan o
       WHERE m.id = o.id
       RETURNING m.id::text AS id,
         (SELECT storage_ref FROM refs WHERE refs.message_id = m.id) AS storage_ref`,
      [accountId, BATCH_SIZE, onlyWhenIdle],
    )
    for (const row of rows) {
      if (row.storage_ref) await removeMessageDir(root, row.storage_ref)
    }
    total += rows.length
    if (rows.length < BATCH_SIZE || jobAborted()) break
  }
  if (total > 0) await removeEmptyThreads(pool, accountId)
  return total
}

/** Runs a batched DELETE (`sql` must take the batch size as $1) until done. */
async function deleteInBatches(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  let total = 0
  for (;;) {
    const { rowCount } = await pool.query(sql, [BATCH_SIZE, ...params])
    const count = rowCount ?? 0
    total += count
    if (count < BATCH_SIZE || jobAborted()) return total
  }
}

/** Latest mtime of a message directory and its raw file (ms), null if gone. */
async function newestMtime(dir: string): Promise<number | null> {
  try {
    const dirStat = await stat(dir)
    const file = await stat(path.join(dir, 'raw.eml.enc')).catch(() => null)
    return Math.max(dirStat.mtimeMs, file?.mtimeMs ?? 0)
  } catch {
    return null
  }
}

/**
 * Scans mail-data for files without a database reference (step 6). Memory
 * stays flat: directories are streamed and checked BATCH_SIZE at a time.
 */
export async function removeOrphanFiles(
  pool: Pool,
  graceMs: number,
): Promise<{ messageDirs: number; accountDirs: number }> {
  const root = path.resolve(mailDataDir())
  const cutoff = Date.now() - graceMs
  const result = { messageDirs: 0, accountDirs: 0 }
  const { rows: accounts } = await pool.query<{ id: string }>(
    'SELECT id::text AS id FROM mail_account',
  )
  const accountIds = new Set(accounts.map((row) => row.id))

  let rootDir
  try {
    rootDir = await opendir(root)
  } catch {
    return result // no volume (yet)
  }
  for await (const accountEntry of rootDir) {
    if (jobAborted()) break
    // Only our own layout: <account uuid>/<message uuid>/raw.eml.enc.
    if (!accountEntry.isDirectory() || !UUID_RE.test(accountEntry.name)) continue
    const accountDir = path.join(root, accountEntry.name)

    if (!accountIds.has(accountEntry.name)) {
      // Deleted account (account_cleanup missed it) or one created after
      // the account list was read: the grace period tells them apart.
      const mtime = await newestMtime(accountDir)
      if (mtime !== null && mtime < cutoff) {
        await rm(accountDir, { recursive: true, force: true })
        result.accountDirs++
      }
      continue
    }

    let batch: string[] = []
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return
      const { rows } = await pool.query<{ id: string; storage_ref: string }>(
        `SELECT message_id::text AS id, storage_ref FROM message_body
         WHERE message_id = ANY($1::uuid[]) AND storage_ref IS NOT NULL`,
        [batch],
      )
      const referenced = new Set(
        rows
          .filter((row) => path.dirname(row.storage_ref) === path.join(accountEntry.name, row.id))
          .map((row) => row.id),
      )
      for (const messageId of batch) {
        if (referenced.has(messageId)) continue
        const dir = path.join(accountDir, messageId)
        const mtime = await newestMtime(dir)
        if (mtime !== null && mtime < cutoff) {
          await rm(dir, { recursive: true, force: true })
          result.messageDirs++
        }
      }
      batch = []
    }

    try {
      for await (const entry of await opendir(accountDir)) {
        if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue
        batch.push(entry.name)
        if (batch.length >= BATCH_SIZE) {
          await flush()
          if (jobAborted()) break
        }
      }
      await flush()
    } catch (err) {
      // The account directory vanished meanwhile (account deleted): skip.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return result
}

export interface CleanupOutcome {
  messages: number
  uploads: number
  outbox: number
  sessions: number
  pushSubscriptions: number
  jobs: number
  orphanMessageDirs: number
  orphanAccountDirs: number
}

export async function runCleanup(
  pool: Pool,
  settings: CleanupSettings = cleanupSettings(),
): Promise<CleanupOutcome> {
  // 1. Messages without location, per account (isolated: one failing
  // account does not stop the others).
  let messages = 0
  const { rows: accounts } = await pool.query<{ id: string }>(
    'SELECT id::text AS id FROM mail_account ORDER BY id',
  )
  for (const account of accounts) {
    if (jobAborted()) break
    try {
      messages += await purgeLocationlessMessages(pool, account.id, true)
    } catch (err) {
      log.warn(
        { accountId: account.id, error: err instanceof Error ? err.name : 'unknown' },
        'cleanup of messages failed',
      )
    }
  }

  // Every batched DELETE repeats its conditions in the outer WHERE: under
  // READ COMMITTED a row changed by a concurrent transaction (an upload
  // just bound by POST /api/outbox, a failed message re-queued by a retry,
  // a re-enabled push subscription) is re-checked against the outer
  // conditions after the lock wait, not against the subquery's. Rows
  // locked right now are skipped (SKIP LOCKED) and handled next run.

  // 2. Uploads never bound to a message, and uploads of settled messages.
  let uploads = await deleteInBatches(
    pool,
    `DELETE FROM attachment_upload
     WHERE outbox_id IS NULL AND created_at < now() - $2::interval
       AND id IN (
         SELECT id FROM attachment_upload
         WHERE outbox_id IS NULL AND created_at < now() - $2::interval
         LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [interval(settings.uploadRetentionMs)],
  )
  uploads += await deleteInBatches(
    pool,
    `DELETE FROM attachment_upload
     WHERE outbox_id IS NOT NULL
       AND id IN (
         SELECT u.id FROM attachment_upload u
         JOIN outbox_message o ON o.id = u.outbox_id
         WHERE o.status = 'sent' AND o.content_enc IS NULL
         LIMIT $1 FOR UPDATE OF u SKIP LOCKED)`,
  )

  // 3. Settled or abandoned outbox entries (uploads cascade).
  const outbox = await deleteInBatches(
    pool,
    `DELETE FROM outbox_message
     WHERE updated_at < now() - $2::interval
       AND ((status = 'sent' AND content_enc IS NULL) OR status = 'failed')
       AND id IN (
         SELECT id FROM outbox_message
         WHERE updated_at < now() - $2::interval
           AND ((status = 'sent' AND content_enc IS NULL) OR status = 'failed')
         LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [interval(settings.outboxRetentionMs)],
  )

  // 4. Sessions past their absolute timeout; long-disabled push subscriptions.
  const sessions = await deleteInBatches(
    pool,
    `DELETE FROM session
     WHERE expires_at < now()
       AND id IN (
         SELECT id FROM session WHERE expires_at < now() LIMIT $1 FOR UPDATE SKIP LOCKED)`,
  )
  const pushSubscriptions = await deleteInBatches(
    pool,
    `DELETE FROM push_subscription
     WHERE disabled_at IS NOT NULL AND disabled_at < now() - $2::interval
       AND id IN (
         SELECT id FROM push_subscription
         WHERE disabled_at IS NOT NULL AND disabled_at < now() - $2::interval
         LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [interval(DISABLED_PUSH_RETENTION_MS)],
  )

  // 5. Old jobs (index job (state, run_at)); queued/running stay.
  const jobs = await deleteInBatches(
    pool,
    `DELETE FROM job
     WHERE ((state = 'done' AND run_at < now() - $2::interval)
         OR (state = 'failed' AND run_at < now() - $3::interval))
       AND id IN (
         SELECT id FROM job
         WHERE (state = 'done' AND run_at < now() - $2::interval)
            OR (state = 'failed' AND run_at < now() - $3::interval)
         LIMIT $1 FOR UPDATE SKIP LOCKED)`,
    [interval(settings.jobRetentionMs), interval(settings.failedJobRetentionMs)],
  )

  // 6. Unreferenced files in the volume.
  const files = jobAborted()
    ? { messageDirs: 0, accountDirs: 0 }
    : await removeOrphanFiles(pool, settings.orphanFileGraceMs)

  return {
    messages,
    uploads,
    outbox,
    sessions,
    pushSubscriptions,
    jobs,
    orphanMessageDirs: files.messageDirs,
    orphanAccountDirs: files.accountDirs,
  }
}
