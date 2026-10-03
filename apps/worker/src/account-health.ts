/**
 * Account health and circuit breaker (roadmap 3.4).
 *
 * Connection-level errors of a job are classified into a stable code and a
 * kind; everything else (bugs, database errors, a single broken message)
 * leaves the account status alone and is handled by the job retry alone.
 *
 * - auth: status 'auth_error', no automatic retry (scheduler and job claim
 *   skip the account) until the credentials are updated via
 *   PATCH /api/accounts/:id, which resets the state.
 * - unreachable: exponential backoff via next_retry_at (1 min doubling up
 *   to 1 h; the job claim skips the account meanwhile). After
 *   CIRCUIT_OPEN_AFTER consecutive failures the status turns 'unreachable'
 *   for the status display. Failures of jobs that were already running
 *   during an open window do not count twice.
 * - A successful sync (folder_sync/message_sync, which always connect)
 *   closes the circuit: status 'ok', counters reset, last_sync_at.
 *
 * Only codes are stored, never server messages (they may quote content).
 */
import type { Pool } from '@fma/db'
import { ACCOUNT_ERROR_MESSAGES, type AccountErrorCode } from '@fma/shared'

export type AccountErrorKind = 'auth' | 'unreachable'

export interface AccountError {
  code: AccountErrorCode
  kind: AccountErrorKind
}

/** Consecutive failures until the status shows 'unreachable'. */
export const CIRCUIT_OPEN_AFTER = 3
const BACKOFF_BASE_SECONDS = 60
const BACKOFF_MAX_SECONDS = 60 * 60

/** Thrown by the job runner when a job exceeds its hard timeout. */
export class JobTimeoutError extends Error {
  readonly code = 'JOB_TIMEOUT'
  constructor(type: string, timeoutMs: number) {
    super(`${type} job exceeded ${timeoutMs} ms`)
    this.name = 'JobTimeoutError'
  }
}

const NETWORK_CODES: Record<string, AccountErrorCode> = {
  ECONNREFUSED: 'CONNECTION_REFUSED',
  ENOTFOUND: 'HOST_NOT_FOUND',
  EAI_AGAIN: 'HOST_NOT_FOUND',
  EDNS: 'HOST_NOT_FOUND',
  ETIMEDOUT: 'TIMEOUT',
  ETIMEOUT: 'TIMEOUT',
  ESOCKETTIMEDOUT: 'TIMEOUT',
  CONNECT_TIMEOUT: 'TIMEOUT',
  GREETING_TIMEOUT: 'TIMEOUT',
  UPGRADE_TIMEOUT: 'TIMEOUT',
  ECONNRESET: 'CONNECTION_LOST',
  EPIPE: 'CONNECTION_LOST',
  EHOSTUNREACH: 'CONNECTION_LOST',
  ENETUNREACH: 'CONNECTION_LOST',
  NoConnection: 'CONNECTION_LOST',
  ETLS: 'TLS_ERROR',
  PRIVATE_HOST_BLOCKED: 'BLOCKED_HOST',
}

/** Codes reported by jobs themselves (e.g. send_message via SendRetryError). */
const KNOWN_CODES = new Set<string>(Object.keys(ACCOUNT_ERROR_MESSAGES))

function kindOf(code: AccountErrorCode): AccountErrorKind {
  return code === 'AUTH_FAILED' || code === 'CREDENTIALS_REQUIRED' ? 'auth' : 'unreachable'
}

/**
 * Maps an error to an account-level error, or null when the error is not
 * about reaching or logging in to the provider.
 */
export function classifyAccountError(err: unknown): AccountError | null {
  if (!err || typeof err !== 'object') return null
  const error = err as {
    code?: unknown
    authenticationFailed?: unknown
    serverResponseCode?: unknown
    responseCode?: unknown
    message?: unknown
  }
  if (error.authenticationFailed === true || error.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return { code: 'AUTH_FAILED', kind: 'auth' }
  }
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'EAUTH' || code === 'ENOAUTH') return { code: 'AUTH_FAILED', kind: 'auth' }
  if (KNOWN_CODES.has(code))
    return { code: code as AccountErrorCode, kind: kindOf(code as AccountErrorCode) }
  const mapped = NETWORK_CODES[code]
  if (mapped) return { code: mapped, kind: kindOf(mapped) }
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.includes('SELF_SIGNED')) {
    return { code: 'TLS_ERROR', kind: 'unreachable' }
  }
  return null
}

/** Closes the circuit after a successful sync (no-op for disabled accounts). */
export async function recordAccountSuccess(pool: Pool, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE mail_account
     SET status = 'ok', error_count = 0, next_retry_at = NULL, last_error_code = NULL,
         last_sync_at = now()
     WHERE id = $1 AND status <> 'disabled'`,
    [accountId],
  )
}

export interface AccountHealth {
  status: string
  errorCount: number
  nextRetryAt: Date | null
}

/** Records a connection-level failure; returns the new state (null: no such account). */
export async function recordAccountFailure(
  pool: Pool,
  accountId: string,
  error: AccountError,
): Promise<AccountHealth | null> {
  const { rows } = await pool.query<{
    status: string
    error_count: number
    next_retry_at: Date | null
  }>(
    `WITH cur AS (
       SELECT id,
         -- Failures inside an open backoff window (jobs that were already
         -- running) do not count again.
         CASE WHEN next_retry_at IS NULL OR next_retry_at <= now()
           THEN error_count + 1 ELSE error_count END AS n
       FROM mail_account WHERE id = $1 AND status <> 'disabled'
       FOR UPDATE
     )
     UPDATE mail_account a SET
       error_count = cur.n,
       last_error_code = $2,
       status = CASE
         WHEN $3 = 'auth' THEN 'auth_error'
         WHEN a.status = 'auth_error' THEN a.status
         WHEN cur.n >= $4 THEN 'unreachable'
         ELSE a.status END,
       next_retry_at = CASE
         WHEN $3 = 'auth' THEN NULL
         ELSE now() + make_interval(secs => LEAST($5 * power(2, cur.n - 1), $6))
       END
     FROM cur WHERE a.id = cur.id
     RETURNING a.status, a.error_count, a.next_retry_at`,
    [
      accountId,
      error.code,
      error.kind,
      CIRCUIT_OPEN_AFTER,
      BACKOFF_BASE_SECONDS,
      BACKOFF_MAX_SECONDS,
    ],
  )
  const row = rows[0]
  if (!row) return null
  return { status: row.status, errorCount: row.error_count, nextRetryAt: row.next_retry_at }
}
