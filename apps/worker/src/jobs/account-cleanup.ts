/**
 * account_cleanup job (roadmap 3.1): removes the encrypted files of a
 * deleted account from the mail-data volume.
 *
 * The api deletes the account row (all database rows cascade, the DEK is
 * gone = crypto-shredding) and enqueues this job, because it only mounts the
 * volume read-only. The payload carries just the account id; job.account_id
 * stays NULL, since it would cascade-delete the job with the account.
 *
 * A job of the deleted account that was already running may still write a
 * file after the first pass, so the job re-enqueues itself once for a
 * delayed second pass (after the stale-job window of the scheduler).
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from '@fma/db'
import { enqueueJob } from '@fma/db/job-queue'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Delay of the second pass; longer than any job may run. */
export const SECOND_PASS_DELAY_MS = 65 * 60_000

export type AccountCleanupOutcome = 'removed' | 'account_exists' | 'invalid'

function mailDataDir(): string {
  return process.env.MAIL_DATA_DIR ?? '/app/mail-data'
}

export async function runAccountCleanup(
  pool: Pool,
  payload: Record<string, unknown>,
): Promise<AccountCleanupOutcome> {
  const accountId = typeof payload.accountId === 'string' ? payload.accountId : ''
  // Strict id check: the id becomes a path segment.
  if (!UUID_RE.test(accountId)) return 'invalid'

  // Never touch the files of an existing account.
  const { rowCount } = await pool.query('SELECT 1 FROM mail_account WHERE id = $1', [accountId])
  if ((rowCount ?? 0) > 0) return 'account_exists'

  const root = path.resolve(mailDataDir())
  const dir = path.resolve(root, accountId.toLowerCase())
  if (path.dirname(dir) !== root) return 'invalid'
  await rm(dir, { recursive: true, force: true })

  if (payload.pass !== 2) {
    await enqueueJob(pool, {
      type: 'account_cleanup',
      payload: { accountId, pass: 2 },
      runAt: new Date(Date.now() + SECOND_PASS_DELAY_MS),
    })
  }
  return 'removed'
}
