/**
 * Integration tests for identity management (roadmap 3.6): add aliases,
 * edit name/signature, choose the default (also used by the outbox),
 * delete non-default identities; validation and ownership. Requires
 * DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import type { ComposeIdentity, IdentityListResponse, OutboxMessage } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES = 'session, device, "user", mail_account, identity, job, outbox_message'

let app: FastifyInstance
let authToken: string

async function createAccount(userId: string, email: string): Promise<string> {
  const id = randomUUID()
  const dek = generateDataKey()
  await pool.query(
    `INSERT INTO mail_account
       (id, user_id, display_name, email_address, imap_host, imap_port,
        smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
     VALUES ($1, $2, 'Konto', $3, 'imap.test', 993, 'smtp.test', 465, $4, 'v1', $5, 'ok')`,
    [
      id,
      userId,
      email,
      Buffer.from(wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1'), 'utf8'),
      Buffer.from(encryptField(dek, '{}', `mail_account.credential:${id}`), 'utf8'),
    ],
  )
  await pool.query(`INSERT INTO identity (account_id, name, email_address) VALUES ($1, $2, $3)`, [
    id,
    'Ich',
    email,
  ])
  return id
}

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    payload: payload as Record<string, unknown> | undefined,
    headers: { cookie: `fma_session=${authToken}` },
  })
}

async function list(accountId: string): Promise<ComposeIdentity[]> {
  return (await call('GET', `/api/accounts/${accountId}/identities`)).json<IdentityListResponse>()
    .identities
}

describe.skipIf(!databaseUrl)('identity management api', () => {
  let accountId: string
  let foreignAccountId: string
  let aliasId: string

  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'identities@example.com', password: 'correct horse battery' },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    accountId = await createAccount(rows[0]!.id, 'me@example.com')
    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other-i@example.com', 'x') RETURNING id`,
    )
    foreignAccountId = await createAccount(other.rows[0]!.id, 'other@example.com')
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('adds an alias identity (address normalized, signature optional)', async () => {
    const res = await call('POST', `/api/accounts/${accountId}/identities`, {
      name: ' Info\nTeam ',
      emailAddress: ' Info@Example.com ',
      signature: 'Gruß\r\n',
    })
    expect(res.statusCode).toBe(201)
    const identity = res.json<{ identity: ComposeIdentity }>().identity
    expect(identity).toMatchObject({
      name: 'Info Team',
      emailAddress: 'info@example.com',
      signature: 'Gruß',
      isDefault: false,
    })
    aliasId = identity.id
    expect((await list(accountId)).map((i) => i.emailAddress)).toEqual([
      'me@example.com',
      'info@example.com',
    ])
  })

  it('rejects invalid input, duplicates and foreign accounts', async () => {
    const url = `/api/accounts/${accountId}/identities`
    for (const body of [
      {},
      { emailAddress: 'nope' },
      { emailAddress: 'a b@example.com' },
      { emailAddress: 'x@example.com', name: 'x'.repeat(101) },
      { emailAddress: 'x@example.com', signature: 5 },
    ]) {
      expect((await call('POST', url, body)).statusCode, JSON.stringify(body)).toBe(400)
    }
    expect((await call('POST', url, { emailAddress: 'INFO@example.com' })).statusCode).toBe(409)
    expect(
      (
        await call('POST', `/api/accounts/${foreignAccountId}/identities`, {
          emailAddress: 'x@example.com',
        })
      ).statusCode,
    ).toBe(404)
  })

  it('edits the display name and signature', async () => {
    const res = await call('PATCH', `/api/identities/${aliasId}`, { name: 'Info', signature: null })
    expect(res.statusCode).toBe(200)
    expect(res.json().identity).toMatchObject({ name: 'Info', signature: null })
    expect(
      (await call('PATCH', `/api/identities/${aliasId}`, { isDefault: false })).statusCode,
    ).toBe(400)
  })

  it('sets the default identity, which the outbox then uses as sender', async () => {
    const res = await call('PATCH', `/api/identities/${aliasId}`, { isDefault: true })
    expect(res.statusCode).toBe(200)
    const identities = await list(accountId)
    expect(identities[0]).toMatchObject({ id: aliasId, isDefault: true })
    expect(identities.filter((i) => i.isDefault)).toHaveLength(1)

    const sent = await call('POST', '/api/outbox', {
      accountId,
      to: ['alice@example.com'],
      subject: 'Test',
      text: 'Hallo',
    })
    expect(sent.statusCode).toBe(201)
    expect(sent.json<OutboxMessage>().from).toEqual({ name: 'Info', address: 'info@example.com' })
  })

  it('refuses to delete the default identity, deletes others', async () => {
    expect((await call('DELETE', `/api/identities/${aliasId}`)).statusCode).toBe(409)
    const main = (await list(accountId)).find((i) => i.emailAddress === 'me@example.com')!
    expect(
      (await call('PATCH', `/api/identities/${main.id}`, { isDefault: true })).statusCode,
    ).toBe(200)
    expect((await call('DELETE', `/api/identities/${aliasId}`)).statusCode).toBe(204)
    expect((await list(accountId)).map((i) => i.id)).toEqual([main.id])
  })

  it('answers 404 for foreign or unknown identities', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM identity WHERE account_id = $1',
      [foreignAccountId],
    )
    const foreignId = rows[0]!.id
    expect((await call('PATCH', `/api/identities/${foreignId}`, { name: 'x' })).statusCode).toBe(
      404,
    )
    expect((await call('DELETE', `/api/identities/${foreignId}`)).statusCode).toBe(404)
    expect((await call('DELETE', `/api/identities/${randomUUID()}`)).statusCode).toBe(404)
    expect((await call('DELETE', '/api/identities/nope')).statusCode).toBe(404)
  })
})
