/**
 * Integration tests for the client-triggered sync (roadmap 4.5): enqueue,
 * dedupe while a folder_sync is queued/running, rate limit per account,
 * ownership, no job for auth_error/backoff accounts, and the `syncing`
 * flag in the account list. Requires DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import type { AccountSummary, SyncAllResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES = 'session, device, "user", mail_account, identity, job'

let app: FastifyInstance
let authToken: string
let userId: string

async function post(url: string, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    headers: token ? { cookie: `fma_session=${token}` } : {},
  })
}

async function createAccount(owner: string, status = 'ok'): Promise<string> {
  const id = randomUUID()
  const dek = generateDataKey()
  const wrapped = wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1')
  await pool.query(
    `INSERT INTO mail_account
       (id, user_id, display_name, email_address, imap_host, imap_port,
        smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
     VALUES ($1, $2, 'Test', $3, 'imap.test', 993, 'smtp.test', 465, $4, 'v1', $5, $6)`,
    [
      id,
      owner,
      `${id}@example.com`,
      Buffer.from(wrapped, 'utf8'),
      Buffer.from(encryptField(dek, '{}', `mail_account.credential:${id}`), 'utf8'),
      status,
    ],
  )
  return id
}

async function syncJobs(accountId: string): Promise<{ state: string }[]> {
  const { rows } = await pool.query<{ state: string }>(
    `SELECT state FROM job WHERE type = 'folder_sync' AND account_id = $1 ORDER BY id`,
    [accountId],
  )
  return rows
}

/** Moves all jobs of the account into the past (outside the rate limit window). */
async function ageJobs(accountId: string, state = 'done'): Promise<void> {
  await pool.query(
    `UPDATE job SET state = $2, created_at = now() - interval '5 minutes' WHERE account_id = $1`,
    [accountId, state],
  )
}

describe.skipIf(!databaseUrl)('sync requests', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'sync@example.com', password: 'correct horse battery' }),
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    userId = rows[0]!.id
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE mail_account, identity, job CASCADE')
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires a session', async () => {
    const accountId = await createAccount(userId)
    expect((await post(`/api/accounts/${accountId}/sync`)).statusCode).toBe(401)
    expect((await post('/api/sync')).statusCode).toBe(401)
    expect(await syncJobs(accountId)).toEqual([])
  })

  it('enqueues a folder_sync and dedupes while it is queued or running', async () => {
    const accountId = await createAccount(userId)
    const first = await post(`/api/accounts/${accountId}/sync`, authToken)
    expect(first.statusCode).toBe(202)
    expect(first.json()).toEqual({ accountId, queued: true, reason: null })

    // Still queued: no second job, even outside the rate limit window.
    await pool.query(
      `UPDATE job SET created_at = now() - interval '5 minutes' WHERE account_id = $1`,
      [accountId],
    )
    const second = await post(`/api/accounts/${accountId}/sync`, authToken)
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ queued: false, reason: 'pending' })

    await pool.query(`UPDATE job SET state = 'running' WHERE account_id = $1`, [accountId])
    const third = await post(`/api/accounts/${accountId}/sync`, authToken)
    expect(third.json()).toMatchObject({ queued: false, reason: 'pending' })
    expect(await syncJobs(accountId)).toHaveLength(1)
  })

  it('rate-limits sync requests per account', async () => {
    const accountId = await createAccount(userId)
    const other = await createAccount(userId)
    expect((await post(`/api/accounts/${accountId}/sync`, authToken)).statusCode).toBe(202)
    // The worker finished quickly; a new request within 30 s is refused.
    await pool.query(`UPDATE job SET state = 'done' WHERE account_id = $1`, [accountId])
    const limited = await post(`/api/accounts/${accountId}/sync`, authToken)
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBe('30')
    expect(limited.json()).toMatchObject({ queued: false, reason: 'rate_limited' })
    // Other accounts are not affected.
    expect((await post(`/api/accounts/${other}/sync`, authToken)).statusCode).toBe(202)

    // After the window a new sync is allowed again.
    await ageJobs(accountId)
    expect((await post(`/api/accounts/${accountId}/sync`, authToken)).statusCode).toBe(202)
    expect(await syncJobs(accountId)).toHaveLength(2)
  })

  it('does not enqueue for auth_error, disabled or backing-off accounts', async () => {
    const authError = await createAccount(userId, 'auth_error')
    const disabled = await createAccount(userId, 'disabled')
    const backoff = await createAccount(userId, 'unreachable')
    await pool.query(
      `UPDATE mail_account SET next_retry_at = now() + interval '10 minutes' WHERE id = $1`,
      [backoff],
    )
    const expected = { [authError]: 'auth_error', [disabled]: 'disabled', [backoff]: 'backoff' }
    for (const [id, reason] of Object.entries(expected)) {
      const res = await post(`/api/accounts/${id}/sync`, authToken)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ accountId: id, queued: false, reason })
      expect(await syncJobs(id)).toEqual([])
    }

    // Backoff over: the circuit is half-open again, a sync may try.
    await pool.query(
      `UPDATE mail_account SET next_retry_at = now() - interval '1 second' WHERE id = $1`,
      [backoff],
    )
    expect((await post(`/api/accounts/${backoff}/sync`, authToken)).statusCode).toBe(202)
  })

  it('returns 404 for foreign, unknown and malformed account ids', async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`other-${randomUUID()}@example.com`],
    )
    const foreign = await createAccount(other.rows[0]!.id)
    for (const id of [foreign, randomUUID(), 'not-a-uuid']) {
      expect((await post(`/api/accounts/${id}/sync`, authToken)).statusCode).toBe(404)
    }
    // POST /api/sync only touches the user's own accounts.
    const res = await post('/api/sync', authToken)
    expect(res.statusCode).toBe(200)
    expect((res.json() as SyncAllResponse).accounts).toEqual([])
    expect(await syncJobs(foreign)).toEqual([])
    await pool.query('DELETE FROM "user" WHERE id = $1', [other.rows[0]!.id])
  })

  it('syncs all accounts of the user at once with per-account results', async () => {
    const healthy = await createAccount(userId)
    const broken = await createAccount(userId, 'auth_error')
    const res = await post('/api/sync', authToken)
    expect(res.statusCode).toBe(200)
    const results = (res.json() as SyncAllResponse).accounts
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.accountId === healthy)).toMatchObject({ queued: true })
    expect(results.find((r) => r.accountId === broken)).toMatchObject({
      queued: false,
      reason: 'auth_error',
    })
    // Repeated focus events: nothing new, but no error either.
    const again = (await post('/api/sync', authToken)).json() as SyncAllResponse
    expect(again.accounts.every((r) => !r.queued)).toBe(true)
    expect(await syncJobs(healthy)).toHaveLength(1)
  })

  it('reports running and claimable syncs as syncing in the account list', async () => {
    const accountId = await createAccount(userId)
    const list = async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/accounts',
        headers: { cookie: `fma_session=${authToken}` },
      })
      return (res.json() as { accounts: AccountSummary[] }).accounts[0]!
    }
    expect((await list()).syncing).toBe(false)
    await post(`/api/accounts/${accountId}/sync`, authToken)
    expect((await list()).syncing).toBe(true)
    // A job waiting for its retry backoff does not count as syncing.
    await pool.query(`UPDATE job SET run_at = now() + interval '5 minutes' WHERE account_id = $1`, [
      accountId,
    ])
    expect((await list()).syncing).toBe(false)
    await ageJobs(accountId, 'running')
    expect((await list()).syncing).toBe(true)
    await ageJobs(accountId, 'done')
    expect((await list()).syncing).toBe(false)
  })
})
