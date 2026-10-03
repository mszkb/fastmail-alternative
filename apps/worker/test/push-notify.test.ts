/**
 * Tests for the push_notify job (roadmap 4.3): web-push delivers to a local
 * fake push service (HTTP server in the test, allowed in test mode only);
 * the test decrypts what arrives and checks that the payload holds only
 * type/installationId/badge - no mail content. Also: 404/410 cleanup,
 * retry on other errors, logged-out devices, coalescing of jobs.
 * Requires DATABASE_URL.
 */
import { createECDH, randomBytes, randomUUID, type ECDH } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import webpush from 'web-push'
import { decrypt } from 'http_ece'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, pushKeysAad, wrapDataKey } from '@fma/crypto'
import { PUSH_PAYLOAD_FIELDS } from '@fma/shared'
import {
  PUSH_MAX_FAILURES,
  enqueuePushNotify,
  endpointRef,
  runPushNotify,
  type VapidConfig,
} from '../src/jobs/push-notify'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES = 'session, device, "user", mail_account, folder, job, push_subscription'

interface Received {
  path: string
  headers: IncomingHttpHeaders
  body: Buffer
}

describe.skipIf(!databaseUrl)('push_notify job', () => {
  let pool: pg.Pool
  let server: Server
  let baseUrl: string
  let received: Received[] = []
  let userId: string
  let accountId: string
  let userDek: Buffer
  const keys = webpush.generateVAPIDKeys()
  const vapid: VapidConfig = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: 'mailto:ops@example.com',
  }

  /** A browser-side subscription: endpoint on the fake service + client keys. */
  async function subscribe(
    path: string,
    options: { loggedIn?: boolean } = {},
  ): Promise<{ id: string; installationId: string; ecdh: ECDH; auth: Buffer }> {
    const installationId = randomUUID()
    const device = await pool.query<{ id: string }>(
      `INSERT INTO device (user_id, name, platform, installation_id)
       VALUES ($1, 'Phone', 'ios_pwa', $2) RETURNING id`,
      [userId, installationId],
    )
    const deviceId = device.rows[0]!.id
    if (options.loggedIn !== false) {
      await pool.query(
        `INSERT INTO session (device_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 day')`,
        [deviceId, randomBytes(32)],
      )
    }
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = randomBytes(16)
    const endpoint = `${baseUrl}${path}/${randomUUID()}`
    const keysJson = JSON.stringify({
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    })
    const row = await pool.query<{ id: string }>(
      `INSERT INTO push_subscription (device_id, transport, endpoint, keys_enc)
       VALUES ($1, 'webpush', $2, $3) RETURNING id`,
      [deviceId, endpoint, Buffer.from(encryptField(userDek, keysJson, pushKeysAad(endpoint)))],
    )
    return { id: row.rows[0]!.id, installationId, ecdh, auth }
  }

  beforeAll(async () => {
    process.env.MAIL_ALLOW_PRIVATE_HOSTS = '1'
    pool = new pg.Pool({ connectionString: databaseUrl })
    await runMigrations(pool)

    // Fake push service: status by path prefix (/ok, /gone, /missing, /error).
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const path = req.url ?? ''
        received.push({ path, headers: req.headers, body: Buffer.concat(chunks) })
        res.statusCode = path.startsWith('/gone')
          ? 410
          : path.startsWith('/missing')
            ? 404
            : path.startsWith('/error')
              ? 500
              : 201
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(async () => {
    received = []
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    userDek = generateDataKey()
    const wrapped = wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), userDek, 'v1')
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash, wrapped_dek, key_id)
       VALUES ('push@example.com', 'x', $1, 'v1') RETURNING id`,
      [Buffer.from(wrapped, 'utf8')],
    )
    userId = user.rows[0]!.id
    accountId = randomUUID()
    await pool.query(
      `INSERT INTO mail_account
         (id, user_id, display_name, email_address, imap_host, imap_port,
          smtp_host, smtp_port, wrapped_dek, key_id, credential_enc)
       VALUES ($1, $2, 'Work', 'secret-person@example.com', 'imap.test', 993,
         'smtp.test', 465, '\\x00', 'v1', '\\x00')`,
      [accountId, userId],
    )
    // Badge: unread INBOX messages only (the Archive count must not count).
    await pool.query(
      `INSERT INTO folder (account_id, path, special_use, unread_count)
       VALUES ($1, 'INBOX', 'inbox', 3), ($1, 'Archive', 'archive', 9)`,
      [accountId],
    )
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
    await new Promise((resolve) => server.close(resolve))
  })

  it('sends a content-free, encrypted payload with VAPID, short TTL and normal urgency', async () => {
    const sub = await subscribe('/ok')
    const outcome = await runPushNotify(pool, { userId }, vapid)
    expect(outcome).toEqual({ sent: 1, removed: 0, failed: 0 })

    expect(received).toHaveLength(1)
    const request = received[0]!
    expect(request.headers['content-encoding']).toBe('aes128gcm')
    expect(request.headers.ttl).toBe('900')
    expect(request.headers.urgency).toBe('normal')
    expect(request.headers.authorization).toMatch(/^vapid t=.+, k=/)

    // Encrypted on the wire: no plaintext fields visible.
    expect(request.body.toString('latin1')).not.toContain('new_mail')
    const payload = JSON.parse(
      decrypt(request.body, {
        version: 'aes128gcm',
        privateKey: sub.ecdh,
        authSecret: sub.auth,
      }).toString('utf8'),
    ) as Record<string, unknown>
    expect(payload).toEqual({ type: 'new_mail', installationId: sub.installationId, badge: 3 })
    expect(
      Object.keys(payload).every((key) => (PUSH_PAYLOAD_FIELDS as readonly string[]).includes(key)),
    ).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('example.com')

    const { rows } = await pool.query(
      'SELECT failure_count, last_success_at IS NOT NULL AS ok FROM push_subscription',
    )
    expect(rows).toEqual([{ failure_count: 0, ok: true }])
  })

  it('removes subscriptions the push service reports as gone (404/410)', async () => {
    const ok = await subscribe('/ok')
    await subscribe('/gone')
    await subscribe('/missing')
    const outcome = await runPushNotify(pool, { userId }, vapid)
    expect(outcome).toEqual({ sent: 1, removed: 2, failed: 0 })
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM push_subscription')
    expect(rows.map((row) => row.id)).toEqual([ok.id])
  })

  it('counts other errors without failing the job, disables after repeated failures', async () => {
    await subscribe('/ok')
    const broken = await subscribe('/error')
    const failures = async () =>
      (
        await pool.query<{ failure_count: number; disabled: boolean }>(
          'SELECT failure_count, disabled_at IS NOT NULL AS disabled FROM push_subscription WHERE id = $1',
          [broken.id],
        )
      ).rows[0]
    // No retry of the whole job: the healthy subscription is notified once.
    expect(await runPushNotify(pool, { userId }, vapid)).toEqual({ sent: 1, removed: 0, failed: 1 })
    expect(await failures()).toEqual({ failure_count: 1, disabled: false })
    expect(received).toHaveLength(2)

    for (let run = 2; run <= PUSH_MAX_FAILURES; run++) {
      await runPushNotify(pool, { userId }, vapid)
    }
    expect(await failures()).toEqual({ failure_count: PUSH_MAX_FAILURES, disabled: true })
    // Disabled: no more delivery attempts to the broken endpoint.
    const before = received.length
    expect(await runPushNotify(pool, { userId }, vapid)).toEqual({ sent: 1, removed: 0, failed: 0 })
    expect(received).toHaveLength(before + 1)
  })

  it('skips devices without an active session and missing VAPID keys', async () => {
    await subscribe('/ok', { loggedIn: false })
    expect(await runPushNotify(pool, { userId }, vapid)).toEqual({ sent: 0, removed: 0, failed: 0 })
    expect(await runPushNotify(pool, { userId }, null)).toBe('not_configured')
    expect(received).toHaveLength(0)
  })

  it('coalesces jobs per user and spaces them at least 30 s apart', async () => {
    // No subscription: nothing to notify.
    expect(await enqueuePushNotify(pool, accountId)).toBe(false)

    await subscribe('/ok')
    expect(await enqueuePushNotify(pool, accountId)).toBe(true)
    // A queued job covers further new mail (badge is computed when it runs).
    expect(await enqueuePushNotify(pool, accountId)).toBe(false)

    await pool.query(`UPDATE job SET state = 'done' WHERE type = 'push_notify'`)
    expect(await enqueuePushNotify(pool, accountId)).toBe(true)
    const { rows } = await pool.query<{ payload: unknown; delayed: boolean }>(
      `SELECT payload, run_at > now() + interval '20 seconds' AS delayed
       FROM job WHERE type = 'push_notify' AND state = 'queued'`,
    )
    expect(rows).toEqual([{ payload: { userId }, delayed: true }])
  })

  it('logs endpoints only as host and hash', () => {
    const ref = endpointRef('https://web.push.apple.com/QGuQyavXutnMH6E2kmWJ')
    expect(ref.pushHost).toBe('web.push.apple.com')
    expect(ref.endpointHash).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(ref)).not.toContain('QGuQ')
  })
})
