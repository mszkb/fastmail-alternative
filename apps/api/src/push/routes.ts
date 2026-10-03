/**
 * Web Push subscriptions (roadmap 4.3, ADR-0005, docs/architecture/push.md).
 *
 * - GET /api/push/vapid-public-key: the instance's VAPID public key (env).
 * - POST /api/push/subscriptions: stores the browser's PushSubscription for
 *   the current device (session -> device). Upsert by endpoint: the browser
 *   reports the same endpoint again after re-login, which moves it to the
 *   new device. An endpoint of another user is refused.
 * - DELETE /api/push/subscriptions (body: endpoint) for this browser,
 *   DELETE /api/push/subscriptions/:id for the device management view.
 * - GET /api/push/subscriptions: the user's subscriptions, without
 *   endpoints or keys.
 *
 * Endpoints are capability URLs: never logged, only their host is shown.
 * They must be https URLs on a public host (SSRF guard, @fma/shared/ssrf);
 * the worker checks the host again before every send. The subscription keys
 * (p256dh/auth) are encrypted with the user DEK (data model: user-related
 * secrets), created on first use.
 */
import type { FastifyInstance } from 'fastify'
import type { Pool } from '@fma/db'
import {
  encryptField,
  generateDataKey,
  loadMasterKey,
  pushKeysAad,
  unwrapDataKey,
  wrapDataKey,
} from '@fma/crypto'
import type {
  PushSubscriptionInfo,
  PushSubscriptionListResponse,
  PushSubscriptionRequest,
  VapidKeyResponse,
} from '@fma/shared'
import { assertPublicHost } from '@fma/shared/ssrf'
import { requireAuth } from '../auth/routes'

const MAX_ENDPOINT_LENGTH = 2048
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/** Test/CI only: local fake push services on http/loopback (see ssrf.ts). */
function allowPrivatePushHosts(): boolean {
  return process.env.MAIL_ALLOW_PRIVATE_HOSTS === '1'
}

export class InvalidSubscriptionError extends Error {}

/** Validated subscription with decoded key sizes checked. */
export interface ValidSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * Validates a PushSubscription JSON: https endpoint on a public host
 * without credentials, P-256 public key (65 bytes, uncompressed) and a
 * 16-byte auth secret, both base64url.
 */
export async function validateSubscription(
  body: Partial<PushSubscriptionRequest> | undefined,
  lookup?: Parameters<typeof assertPublicHost>[1],
): Promise<ValidSubscription> {
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new InvalidSubscriptionError('Ungültiger Push-Endpoint.')
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new InvalidSubscriptionError('Ungültiger Push-Endpoint.')
  }
  const allowHttp = allowPrivatePushHosts() && url.protocol === 'http:'
  if ((url.protocol !== 'https:' && !allowHttp) || url.username || url.password) {
    throw new InvalidSubscriptionError('Der Push-Endpoint muss eine https-URL sein.')
  }
  if (!allowPrivatePushHosts()) {
    try {
      // URL.hostname keeps IPv6 brackets; the guard expects the bare address.
      await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''), lookup)
    } catch {
      throw new InvalidSubscriptionError('Der Push-Endpoint ist nicht erreichbar.')
    }
  }

  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : ''
  const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : ''
  const publicKey = decodeBase64Url(p256dh)
  const authSecret = decodeBase64Url(auth)
  if (publicKey?.length !== 65 || publicKey[0] !== 0x04 || authSecret?.length !== 16) {
    throw new InvalidSubscriptionError('Ungültige Schlüssel der Push-Subscription.')
  }
  return { endpoint, keys: { p256dh, auth } }
}

function decodeBase64Url(value: string): Buffer | null {
  const trimmed = value.replace(/=+$/, '')
  if (!trimmed || !BASE64URL_RE.test(trimmed)) return null
  return Buffer.from(trimmed, 'base64url')
}

/**
 * Returns the user's data key, creating and storing it on first use. A
 * concurrent first use keeps whichever key was stored first.
 */
export async function ensureUserKey(pool: Pool, userId: string): Promise<Buffer> {
  const masterKey = loadMasterKey(process.env.MASTER_KEY ?? '')
  const keyId = process.env.MASTER_KEY_ID ?? 'v1'
  const wrapped = wrapDataKey(masterKey, generateDataKey(), keyId)
  await pool.query(
    `UPDATE "user" SET wrapped_dek = $2, key_id = $3 WHERE id = $1 AND wrapped_dek IS NULL`,
    [userId, Buffer.from(wrapped, 'utf8'), keyId],
  )
  const { rows } = await pool.query<{ wrapped_dek: Buffer }>(
    'SELECT wrapped_dek FROM "user" WHERE id = $1',
    [userId],
  )
  const stored = rows[0]?.wrapped_dek
  if (!stored) throw new Error('user key missing')
  return unwrapDataKey(masterKey, stored.toString('utf8')).dataKey
}

/**
 * Stores the subscription for the device (upsert by endpoint). Returns
 * null when the endpoint belongs to another user.
 */
export async function saveSubscription(
  pool: Pool,
  userId: string,
  deviceId: string,
  subscription: ValidSubscription,
): Promise<{ id: string } | null> {
  const dek = await ensureUserKey(pool, userId)
  const keysEnc = encryptField(
    dek,
    JSON.stringify(subscription.keys),
    pushKeysAad(subscription.endpoint),
  )
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO push_subscription (device_id, transport, endpoint, keys_enc)
     VALUES ($1, 'webpush', $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET
       device_id = EXCLUDED.device_id,
       keys_enc = EXCLUDED.keys_enc,
       failure_count = 0,
       disabled_at = NULL
     WHERE push_subscription.device_id IN (SELECT id FROM device WHERE user_id = $4)
     RETURNING id`,
    [deviceId, subscription.endpoint, Buffer.from(keysEnc, 'utf8'), userId],
  )
  const id = rows[0]?.id
  return id ? { id: String(id) } : null
}

export async function listSubscriptions(
  pool: Pool,
  userId: string,
  currentDeviceId: string,
): Promise<PushSubscriptionInfo[]> {
  const { rows } = await pool.query<{
    id: string
    device_id: string
    device_name: string
    platform: string
    endpoint: string
    created_at: Date
    last_success_at: Date | null
  }>(
    `SELECT ps.id, ps.device_id, d.name AS device_name, d.platform, ps.endpoint,
            ps.created_at, ps.last_success_at
     FROM push_subscription ps
     JOIN device d ON d.id = ps.device_id
     WHERE d.user_id = $1 AND d.revoked_at IS NULL AND ps.disabled_at IS NULL
     ORDER BY (ps.device_id = $2) DESC, ps.created_at DESC`,
    [userId, currentDeviceId],
  )
  return rows.map((row) => ({
    id: String(row.id),
    deviceId: String(row.device_id),
    deviceName: row.device_name,
    platform: row.platform,
    isCurrentDevice: String(row.device_id) === currentDeviceId,
    pushService: hostOf(row.endpoint),
    createdAt: new Date(row.created_at).toISOString(),
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
  }))
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  const pool = app.authPool

  app.get('/api/push/vapid-public-key', { preHandler: requireAuth }, async (_request, reply) => {
    const body: VapidKeyResponse = { publicKey: process.env.VAPID_PUBLIC_KEY || null }
    await reply.send(body)
  })

  app.get('/api/push/subscriptions', { preHandler: requireAuth }, async (request, reply) => {
    const body: PushSubscriptionListResponse = {
      subscriptions: await listSubscriptions(pool, request.auth!.userId, request.auth!.deviceId),
    }
    await reply.send(body)
  })

  app.post<{ Body: Partial<PushSubscriptionRequest> }>(
    '/api/push/subscriptions',
    { preHandler: requireAuth },
    async (request, reply) => {
      let subscription: ValidSubscription
      try {
        subscription = await validateSubscription(request.body)
      } catch (err) {
        if (!(err instanceof InvalidSubscriptionError)) throw err
        await reply.code(400).send({ message: err.message })
        return
      }
      const saved = await saveSubscription(
        pool,
        request.auth!.userId,
        request.auth!.deviceId,
        subscription,
      )
      if (!saved) {
        await reply.code(409).send({ message: 'Push-Subscription gehört zu einem anderen Konto.' })
        return
      }
      await reply.code(201).send(saved)
    },
  )

  // This browser unsubscribes: identified by its endpoint.
  app.delete<{ Body: { endpoint?: string } }>(
    '/api/push/subscriptions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const endpoint = typeof request.body?.endpoint === 'string' ? request.body.endpoint : ''
      const { rowCount } = await pool.query(
        `DELETE FROM push_subscription
         WHERE endpoint = $1
           AND device_id IN (SELECT id FROM device WHERE user_id = $2)`,
        [endpoint, request.auth!.userId],
      )
      if (!rowCount) {
        await reply.code(404).send({ message: 'Push-Subscription nicht gefunden.' })
        return
      }
      await reply.code(204).send()
    },
  )

  // Device management: remove any subscription of the user.
  app.delete<{ Params: { id: string } }>(
    '/api/push/subscriptions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { rowCount } = UUID_RE.test(request.params.id)
        ? await pool.query(
            `DELETE FROM push_subscription
             WHERE id = $1 AND device_id IN (SELECT id FROM device WHERE user_id = $2)`,
            [request.params.id, request.auth!.userId],
          )
        : { rowCount: 0 }
      if (!rowCount) {
        await reply.code(404).send({ message: 'Push-Subscription nicht gefunden.' })
        return
      }
      await reply.code(204).send()
    },
  )
}
