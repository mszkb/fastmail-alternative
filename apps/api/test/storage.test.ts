/**
 * Integration tests for the storage usage (roadmap 5.4): sums per account
 * from messages with stored bodies and pending uploads, ownership (404 for
 * foreign accounts) and auth. Requires DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import type { AccountStorage, StorageResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES = 'session, device, "user", mail_account, identity, job'

let app: FastifyInstance
let authToken: string
let userId: string

async function get(url: string, token?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { cookie: `fma_session=${token}` } : {},
  })
}

async function createAccount(owner: string, sortOrder = 0): Promise<string> {
  const id = randomUUID()
  const dek = generateDataKey()
  const wrapped = wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1')
  await pool.query(
    `INSERT INTO mail_account
       (id, user_id, display_name, email_address, imap_host, imap_port,
        smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, sort_order)
     VALUES ($1, $2, 'Test', $3, 'imap.test', 993, 'smtp.test', 465, $4, 'v1', $5, $6)`,
    [
      id,
      owner,
      `${id}@example.com`,
      Buffer.from(wrapped, 'utf8'),
      Buffer.from(encryptField(dek, '{}', `mail_account.credential:${id}`), 'utf8'),
      sortOrder,
    ],
  )
  return id
}

/** body: 'stored' (raw in the volume), 'skipped' (marker row) or 'none'. */
async function addMessage(
  accountId: string,
  sizeBytes: number,
  body: 'stored' | 'skipped' | 'none',
): Promise<void> {
  const id = randomUUID()
  await pool.query(
    `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
       recipients_enc, snippet_enc, size_bytes)
     VALUES ($1, $2, $3, '\\x00', '\\x00', '\\x00', '\\x00', $4)`,
    [id, accountId, `<${id}@x>`, sizeBytes],
  )
  if (body === 'stored') {
    await pool.query(`INSERT INTO message_body (message_id, storage_ref) VALUES ($1, $2)`, [
      id,
      `${accountId}/${id}/raw.eml.enc`,
    ])
  } else if (body === 'skipped') {
    await pool.query(
      `INSERT INTO message_body (message_id, skip_reason) VALUES ($1, 'too_large')`,
      [id],
    )
  }
}

async function addUpload(accountId: string, sizeBytes: number): Promise<void> {
  await pool.query(
    `INSERT INTO attachment_upload
       (id, account_id, filename_enc, content_type, size_bytes, content_enc)
     VALUES ($1, $2, '\\x00', 'application/octet-stream', $3, '\\x00')`,
    [randomUUID(), accountId, sizeBytes],
  )
}

async function createUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "user" (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`${randomUUID()}@example.com`],
  )
  return rows[0]!.id
}

describe.skipIf(!databaseUrl)('storage usage', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        setupCode: SETUP_CODE,
        email: 'storage@example.com',
        password: 'correct horse battery',
      }),
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
    expect((await get(`/api/accounts/${accountId}/storage`)).statusCode).toBe(401)
    expect((await get('/api/storage')).statusCode).toBe(401)
  })

  it('sums stored messages and pending uploads per account', async () => {
    const accountId = await createAccount(userId)
    await addMessage(accountId, 1000, 'stored')
    await addMessage(accountId, 2500, 'stored')
    await addMessage(accountId, 30_000_000, 'skipped')
    await addMessage(accountId, 700, 'none')
    await addUpload(accountId, 400)
    await addUpload(accountId, 100)

    const res = await get(`/api/accounts/${accountId}/storage`, authToken)
    expect(res.statusCode).toBe(200)
    expect(res.json<AccountStorage>()).toEqual({
      accountId,
      messageCount: 4,
      storedMessageCount: 2,
      messageBytes: 3500,
      uploadCount: 2,
      uploadBytes: 500,
      totalBytes: 4000,
    })
  })

  it('reports empty accounts with zeros and totals over all accounts', async () => {
    const first = await createAccount(userId, 0)
    const empty = await createAccount(userId, 1)
    await addMessage(first, 2048, 'stored')
    await addUpload(first, 1024)
    // Other users' accounts are not counted.
    const foreign = await createAccount(await createUser())
    await addMessage(foreign, 99_999, 'stored')

    const res = await get('/api/storage', authToken)
    expect(res.statusCode).toBe(200)
    const body = res.json<StorageResponse>()
    expect(body.accounts.map((a) => a.accountId)).toEqual([first, empty])
    expect(body.accounts[1]).toMatchObject({ messageCount: 0, totalBytes: 0 })
    expect(body.totalBytes).toBe(3072)
  })

  it('returns 404 for foreign or unknown accounts', async () => {
    const foreign = await createAccount(await createUser())
    await addMessage(foreign, 1234, 'stored')
    const res = await get(`/api/accounts/${foreign}/storage`, authToken)
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('1234')
    expect((await get(`/api/accounts/${randomUUID()}/storage`, authToken)).statusCode).toBe(404)
    expect((await get('/api/accounts/not-a-uuid/storage', authToken)).statusCode).toBe(404)
  })
})
