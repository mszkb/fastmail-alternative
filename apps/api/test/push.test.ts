/**
 * Integration tests for push subscriptions (roadmap 4.3): auth, validation
 * (https, SSRF guard, key sizes), keys encrypted with the user DEK, upsert
 * by endpoint bound to the current device, ownership, delete, listing
 * without endpoints, cleanup on logout/device revocation.
 * Requires DATABASE_URL; skipped when unset.
 */
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { decryptField, loadMasterKey, pushKeysAad, unwrapDataKey } from '@fma/crypto'
import type { PushSubscriptionListResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'
import { validateSubscription } from '../src/push/routes'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES = 'session, device, "user", push_subscription'
const PASSWORD = 'correct horse battery'
const ALLOW_PRIVATE = process.env.MAIL_ALLOW_PRIVATE_HOSTS

let app: FastifyInstance
let token: string
let userId: string

function keys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  }
}

/** Public literal IP: no DNS needed, passes the SSRF guard. */
function endpoint(): string {
  return `https://93.184.216.34/push/${randomUUID()}`
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
  session: string | undefined = token,
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(session ? { cookie: `fma_session=${session}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  })
}

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: 'push@example.com', password: PASSWORD }),
  })
  return res.cookies.find((c) => c.name === 'fma_session')!.value
}

describe.skipIf(!databaseUrl)('push subscriptions', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'push@example.com', password: PASSWORD }),
    })
    token = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    userId = rows[0]!.id
  })

  afterEach(async () => {
    await pool.query('TRUNCATE push_subscription')
    if (ALLOW_PRIVATE === undefined) delete process.env.MAIL_ALLOW_PRIVATE_HOSTS
    else process.env.MAIL_ALLOW_PRIVATE_HOSTS = ALLOW_PRIVATE
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/push/vapid-public-key'],
      ['GET', '/api/push/subscriptions'],
      ['POST', '/api/push/subscriptions'],
      ['DELETE', '/api/push/subscriptions'],
    ] as const) {
      expect((await call(method, url, undefined, '')).statusCode).toBe(401)
    }
  })

  it('returns the VAPID public key from the environment (null when unset)', async () => {
    const previous = process.env.VAPID_PUBLIC_KEY
    try {
      process.env.VAPID_PUBLIC_KEY = 'BPublicKey'
      expect((await call('GET', '/api/push/vapid-public-key')).json()).toEqual({
        publicKey: 'BPublicKey',
      })
      delete process.env.VAPID_PUBLIC_KEY
      expect((await call('GET', '/api/push/vapid-public-key')).json()).toEqual({
        publicKey: null,
      })
    } finally {
      if (previous === undefined) delete process.env.VAPID_PUBLIC_KEY
      else process.env.VAPID_PUBLIC_KEY = previous
    }
  })

  it('stores the subscription for the current device with encrypted keys', async () => {
    const subscription = { endpoint: endpoint(), keys: keys() }
    const res = await call('POST', '/api/push/subscriptions', subscription)
    expect(res.statusCode).toBe(201)

    const { rows } = await pool.query<{
      endpoint: string
      keys_enc: Buffer
      transport: string
      device_id: string
    }>('SELECT endpoint, keys_enc, transport, device_id FROM push_subscription')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.transport).toBe('webpush')
    const stored = row.keys_enc.toString('utf8')
    expect(stored).not.toContain(subscription.keys.p256dh)
    expect(stored).not.toContain(subscription.keys.auth)

    // Decryptable with the user's DEK (created on first use) only.
    const user = await pool.query<{ wrapped_dek: Buffer }>(
      'SELECT wrapped_dek FROM "user" WHERE id = $1',
      [userId],
    )
    const dek = unwrapDataKey(
      loadMasterKey(process.env.MASTER_KEY!),
      user.rows[0]!.wrapped_dek.toString('utf8'),
    ).dataKey
    expect(JSON.parse(decryptField(dek, stored, pushKeysAad(subscription.endpoint)))).toEqual(
      subscription.keys,
    )

    const devices = await pool.query<{ device_id: string }>(
      `SELECT s.device_id FROM session s WHERE s.token_hash = sha256($1::bytea)`,
      [Buffer.from(token, 'utf8')],
    )
    expect(row.device_id).toBe(devices.rows[0]!.device_id)
  })

  it('upserts by endpoint and moves it to the device that reports it', async () => {
    const subscription = { endpoint: endpoint(), keys: keys() }
    expect((await call('POST', '/api/push/subscriptions', subscription)).statusCode).toBe(201)
    await pool.query('UPDATE push_subscription SET failure_count = 3')

    // Same browser after a new login (= new device), with rotated keys.
    const second = await login()
    const updated = { endpoint: subscription.endpoint, keys: keys() }
    expect((await call('POST', '/api/push/subscriptions', updated, second)).statusCode).toBe(201)

    const { rows } = await pool.query<{ failure_count: number }>(
      'SELECT failure_count FROM push_subscription',
    )
    expect(rows).toEqual([{ failure_count: 0 }])
    const list = (
      await call('GET', '/api/push/subscriptions', undefined, second)
    ).json() as PushSubscriptionListResponse
    expect(list.subscriptions).toHaveLength(1)
    expect(list.subscriptions[0]!.isCurrentDevice).toBe(true)
  })

  it('rejects invalid subscriptions', async () => {
    const valid = keys()
    const bad = [
      {},
      { endpoint: 'not a url', keys: valid },
      { endpoint: 'ftp://push.example.com/x', keys: valid },
      { endpoint: 'https://user:pw@93.184.216.34/x', keys: valid },
      { endpoint: endpoint(), keys: { p256dh: valid.p256dh } },
      { endpoint: endpoint(), keys: { p256dh: 'abc', auth: valid.auth } },
      { endpoint: endpoint(), keys: { p256dh: valid.p256dh, auth: 'a+b/' } },
      { endpoint: `https://93.184.216.34/${'x'.repeat(3000)}`, keys: valid },
    ]
    for (const body of bad) {
      expect((await call('POST', '/api/push/subscriptions', body)).statusCode).toBe(400)
    }
    expect((await pool.query('SELECT 1 FROM push_subscription')).rowCount).toBe(0)
  })

  it('blocks http and private hosts outside of test mode (SSRF)', async () => {
    process.env.MAIL_ALLOW_PRIVATE_HOSTS = '0'
    for (const url of [
      'http://93.184.216.34/push',
      'https://127.0.0.1/push',
      'https://10.1.2.3/push',
      'https://[::1]/push',
      'https://169.254.169.254/latest',
    ]) {
      const res = await call('POST', '/api/push/subscriptions', { endpoint: url, keys: keys() })
      expect(res.statusCode).toBe(400)
    }
    // Host names are resolved: a name pointing to a private address is refused.
    await expect(
      validateSubscription({ endpoint: 'https://push.internal/x', keys: keys() }, async () => [
        { address: '192.168.1.10', family: 4 },
      ]),
    ).rejects.toThrow()
    await expect(
      validateSubscription({ endpoint: 'https://web.push.apple.com/x', keys: keys() }, async () => [
        { address: '17.253.1.1', family: 4 },
      ]),
    ).resolves.toMatchObject({ endpoint: 'https://web.push.apple.com/x' })
  })

  it('keeps subscriptions of other users apart', async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other@example.com', 'x') RETURNING id`,
    )
    const device = await pool.query<{ id: string }>(
      `INSERT INTO device (user_id, name, platform, installation_id)
       VALUES ($1, 'Other', 'desktop', gen_random_uuid()) RETURNING id`,
      [other.rows[0]!.id],
    )
    const foreign = endpoint()
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO push_subscription (device_id, transport, endpoint, keys_enc)
       VALUES ($1, 'webpush', $2, '\\x00') RETURNING id`,
      [device.rows[0]!.id, foreign],
    )

    expect(
      (await call('POST', '/api/push/subscriptions', { endpoint: foreign, keys: keys() }))
        .statusCode,
    ).toBe(409)
    expect(
      (await call('DELETE', '/api/push/subscriptions', { endpoint: foreign })).statusCode,
    ).toBe(404)
    expect(
      (await call('DELETE', `/api/push/subscriptions/${inserted.rows[0]!.id}`)).statusCode,
    ).toBe(404)
    const list = (
      await call('GET', '/api/push/subscriptions')
    ).json() as PushSubscriptionListResponse
    expect(list.subscriptions).toEqual([])
    expect((await pool.query('SELECT 1 FROM push_subscription')).rowCount).toBe(1)
    await pool.query('DELETE FROM "user" WHERE id = $1', [other.rows[0]!.id])
  })

  it('lists without endpoints and deletes by endpoint or id', async () => {
    const first = { endpoint: endpoint(), keys: keys() }
    const second = { endpoint: endpoint(), keys: keys() }
    await call('POST', '/api/push/subscriptions', first)
    await call('POST', '/api/push/subscriptions', second)

    const res = await call('GET', '/api/push/subscriptions')
    expect(res.body).not.toContain('/push/')
    const list = res.json() as PushSubscriptionListResponse
    expect(list.subscriptions).toHaveLength(2)
    expect(list.subscriptions[0]).toMatchObject({ pushService: '93.184.216.34' })

    expect(
      (await call('DELETE', '/api/push/subscriptions', { endpoint: first.endpoint })).statusCode,
    ).toBe(204)
    expect(
      (await call('DELETE', '/api/push/subscriptions', { endpoint: first.endpoint })).statusCode,
    ).toBe(404)
    const remaining = (
      await call('GET', '/api/push/subscriptions')
    ).json() as PushSubscriptionListResponse
    expect(remaining.subscriptions).toHaveLength(1)
    expect(
      (await call('DELETE', `/api/push/subscriptions/${remaining.subscriptions[0]!.id}`))
        .statusCode,
    ).toBe(204)
    expect((await call('DELETE', '/api/push/subscriptions/not-a-uuid')).statusCode).toBe(404)
  })

  it('removes subscriptions on logout and device revocation', async () => {
    const session = await login()
    await call('POST', '/api/push/subscriptions', { endpoint: endpoint(), keys: keys() }, session)
    expect((await call('DELETE', '/api/auth/session', undefined, session)).statusCode).toBe(204)
    expect((await pool.query('SELECT 1 FROM push_subscription')).rowCount).toBe(0)

    const revoked = await login()
    await call('POST', '/api/push/subscriptions', { endpoint: endpoint(), keys: keys() }, revoked)
    const list = (
      await call('GET', '/api/push/subscriptions')
    ).json() as PushSubscriptionListResponse
    const deviceId = list.subscriptions[0]!.deviceId
    expect((await call('DELETE', `/api/auth/devices/${deviceId}`)).statusCode).toBe(204)
    expect((await pool.query('SELECT 1 FROM push_subscription')).rowCount).toBe(0)
  })
})
