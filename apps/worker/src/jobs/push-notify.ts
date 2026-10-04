/**
 * push_notify job (roadmap 4.3, ADR-0005, docs/architecture/push.md): sends
 * a content-free Web Push to every active subscription of a user.
 *
 * - Enqueued by message_sync when new unseen messages arrive in an INBOX
 *   (enqueuePushNotify): at most one queued job per user, and jobs of a
 *   user at least PUSH_COALESCE_SECONDS apart, so a burst of new mail
 *   (several accounts, many messages) yields one notification.
 * - Payload: ONLY { type, installationId, badge } (@fma/shared
 *   buildPushPayload; CLAUDE.md rule 4). The badge is computed when the job
 *   runs: unread INBOX messages over all accounts of the user.
 * - Sent with web-push (VAPID, aes128gcm); the request goes out via fetch
 *   with a timeout, without redirects, and only to public hosts (SSRF guard
 *   again at send time).
 * - 404/410 from the push service: the subscription is gone and deleted.
 *   Other failures: failure_count++; after PUSH_MAX_FAILURES failures in a
 *   row the subscription is disabled (re-subscribing in the app enables it
 *   again). The job itself is not retried: that would notify the healthy
 *   subscriptions again, and push is only a hint (the app syncs on focus).
 * - Endpoints are capability URLs: logs only show the push service host and
 *   a short hash.
 */
import { createHash } from 'node:crypto'
import webpush from 'web-push'
import type { Pool } from '@fma/db'
import { decryptField, loadMasterKey, pushKeysAad, unwrapDataKey } from '@fma/crypto'
import { buildPushPayload } from '@fma/shared'
import { assertPublicHost } from '@fma/shared/ssrf'
import { log } from '../log'
import { mailTestMode } from '../ports'

/** Minimum distance between two push jobs of a user. */
export const PUSH_COALESCE_SECONDS = 30
/** Push services drop the message when the device is offline this long. */
const PUSH_TTL_SECONDS = 15 * 60
const PUSH_REQUEST_TIMEOUT_MS = 15_000
/** Consecutive failed deliveries after which a subscription is disabled. */
export const PUSH_MAX_FAILURES = 5

export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

export function vapidConfigFromEnv(): VapidConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return null
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' }
}

/**
 * Enqueues a push_notify job for the user of the account, unless one is
 * already queued or the user has no active subscription. Returns true when
 * a job was created.
 */
export async function enqueuePushNotify(pool: Pool, accountId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `WITH target AS (
       SELECT ma.user_id FROM mail_account ma WHERE ma.id = $1
     )
     INSERT INTO job (type, payload, run_at)
     SELECT 'push_notify', jsonb_build_object('userId', t.user_id::text),
       GREATEST(now(), COALESCE((
         SELECT max(j.run_at) FROM job j
         WHERE j.type = 'push_notify' AND j.payload->>'userId' = t.user_id::text
       ), now()) + make_interval(secs => $2))
     FROM target t
     WHERE NOT EXISTS (
         SELECT 1 FROM job j
         WHERE j.type = 'push_notify' AND j.payload->>'userId' = t.user_id::text
           AND j.state = 'queued'
       )
       AND EXISTS (
         SELECT 1 FROM push_subscription ps JOIN device d ON d.id = ps.device_id
         WHERE d.user_id = t.user_id AND ps.disabled_at IS NULL AND d.revoked_at IS NULL
       )`,
    [accountId, PUSH_COALESCE_SECONDS],
  )
  return (rowCount ?? 0) > 0
}

/** Log-safe reference to an endpoint: push service host + short hash. */
export function endpointRef(endpoint: string): { pushHost: string; endpointHash: string } {
  let pushHost = 'invalid'
  try {
    pushHost = new URL(endpoint).host
  } catch {
    // keep 'invalid'
  }
  return {
    pushHost,
    endpointHash: createHash('sha256').update(endpoint).digest('hex').slice(0, 12),
  }
}

export interface PushNotifyOutcome {
  sent: number
  removed: number
  failed: number
}

/** Unread INBOX messages over all accounts of the user (the app badge). */
export async function userBadgeCount(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ unread: number }>(
    `SELECT COALESCE(sum(f.unread_count), 0)::int AS unread
     FROM folder f JOIN mail_account ma ON ma.id = f.account_id
     WHERE ma.user_id = $1 AND f.special_use = 'inbox'`,
    [userId],
  )
  return rows[0]?.unread ?? 0
}

export async function runPushNotify(
  pool: Pool,
  payload: Record<string, unknown>,
  vapid: VapidConfig | null = vapidConfigFromEnv(),
): Promise<PushNotifyOutcome | 'not_configured'> {
  const userId = typeof payload.userId === 'string' ? payload.userId : null
  if (!userId) throw new Error('push_notify job without userId')
  if (!vapid) {
    // Nothing to retry: the instance has no VAPID keys (setup-env.mjs).
    log.warn('push_notify skipped: VAPID keys not configured')
    return 'not_configured'
  }

  // Only devices that are still logged in (active session, not revoked).
  const { rows } = await pool.query<{
    id: string
    endpoint: string
    keys_enc: Buffer
    installation_id: string
    wrapped_dek: Buffer | null
  }>(
    `SELECT ps.id, ps.endpoint, ps.keys_enc, d.installation_id, u.wrapped_dek
     FROM push_subscription ps
     JOIN device d ON d.id = ps.device_id
     JOIN "user" u ON u.id = d.user_id
     WHERE d.user_id = $1 AND ps.transport = 'webpush' AND ps.disabled_at IS NULL
       AND d.revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM session s WHERE s.device_id = d.id AND s.expires_at > now())`,
    [userId],
  )
  const outcome: PushNotifyOutcome = { sent: 0, removed: 0, failed: 0 }
  if (rows.length === 0) return outcome

  const wrapped = rows[0]?.wrapped_dek
  if (!wrapped) throw new Error('user key missing')
  const dek = unwrapDataKey(
    loadMasterKey(process.env.MASTER_KEY ?? ''),
    wrapped.toString('utf8'),
  ).dataKey
  const badge = await userBadgeCount(pool, userId)

  for (const row of rows) {
    const ref = endpointRef(row.endpoint)
    let status: number
    try {
      const keys = JSON.parse(
        decryptField(dek, row.keys_enc.toString('utf8'), pushKeysAad(row.endpoint)),
      ) as { p256dh: string; auth: string }
      status = await deliver(
        { endpoint: row.endpoint, keys },
        JSON.stringify(buildPushPayload(String(row.installation_id), badge)),
        vapid,
      )
    } catch (err) {
      status = 0
      log.warn(
        { subscriptionId: row.id, ...ref, errName: err instanceof Error ? err.name : typeof err },
        'push delivery error',
      )
    }

    if (status >= 200 && status < 300) {
      outcome.sent++
      await pool.query(
        'UPDATE push_subscription SET failure_count = 0, last_success_at = now() WHERE id = $1',
        [row.id],
      )
    } else if (status === 404 || status === 410) {
      // Expired or unsubscribed in the browser: the endpoint is gone for good.
      outcome.removed++
      await pool.query('DELETE FROM push_subscription WHERE id = $1', [row.id])
      log.info({ subscriptionId: row.id, ...ref, status }, 'push subscription expired, removed')
    } else {
      outcome.failed++
      const { rows: updated } = await pool.query<{ disabled: boolean }>(
        `UPDATE push_subscription SET failure_count = failure_count + 1,
           disabled_at = CASE WHEN failure_count + 1 >= $2 THEN now() ELSE disabled_at END
         WHERE id = $1
         RETURNING disabled_at IS NOT NULL AS disabled`,
        [row.id, PUSH_MAX_FAILURES],
      )
      if (status !== 0) {
        log.warn({ subscriptionId: row.id, ...ref, status }, 'push delivery failed')
      }
      if (updated[0]?.disabled) {
        log.warn({ subscriptionId: row.id, ...ref }, 'push subscription disabled after failures')
      }
    }
  }

  return outcome
}

/** Sends one encrypted push message; returns the push service's HTTP status. */
async function deliver(
  subscription: webpush.PushSubscription,
  body: string,
  vapid: VapidConfig,
): Promise<number> {
  const url = new URL(subscription.endpoint)
  // MAIL_INSECURE_TRANSPORT=1 (dev/test): local fake push service on http/loopback.
  if (!mailTestMode()) {
    if (url.protocol !== 'https:') throw new Error('push endpoint is not https')
    await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''))
  }
  const details = webpush.generateRequestDetails(subscription, body, {
    TTL: PUSH_TTL_SECONDS,
    urgency: 'normal',
    vapidDetails: vapid,
  })
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(details.headers)) {
    // fetch computes the length itself.
    if (name.toLowerCase() !== 'content-length') headers[name] = String(value)
  }
  const response = await fetch(details.endpoint, {
    method: details.method,
    headers,
    body: details.body ? new Uint8Array(details.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
  })
  // The body may echo the endpoint; it is not needed.
  await response.body?.cancel().catch(() => {})
  return response.status
}
