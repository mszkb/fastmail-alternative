/**
 * Integration tests for mail account management (roadmap 2.1): create with
 * connection test against a local GreenMail container, list without
 * credential leakage, delete with crypto-shredding.
 *
 * Requires DATABASE_URL (Postgres) and a GreenMail instance:
 *   GREENMAIL_HOST, GREENMAIL_IMAP_PORT, GREENMAIL_SMTP_PORT,
 *   GREENMAIL_USER, GREENMAIL_PASSWORD, MAIL_ALLOW_PRIVATE_HOSTS=1
 * CI provides both as service containers; skipped when unset.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
let app: FastifyInstance
let authToken: string

async function inject(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { payload?: object; token?: string } = {},
) {
  return app.inject({
    method,
    url,
    ...(opts.payload ? { payload: JSON.stringify(opts.payload) } : {}),
    headers: {
      ...(opts.payload ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { cookie: `fma_session=${opts.token}` } : {}),
    },
  })
}

describe.skipIf(!databaseUrl || !greenmailHost)('mail accounts', () => {
  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query('TRUNCATE session, device, "user", mail_account, identity CASCADE')

    // Register the single user and grab a session.
    const setup = await inject('POST', '/api/auth/setup', {
      payload: { email: 'accounts@example.com', password: 'correct horse battery' },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
  })

  afterAll(async () => {
    await pool.query('TRUNCATE session, device, "user", mail_account, identity CASCADE')
    await pool.end()
  })

  it('rejects unauthenticated access', async () => {
    const res = await inject('GET', '/api/accounts')
    expect(res.statusCode).toBe(401)
  })

  it('rejects invalid payloads', async () => {
    const res = await inject('POST', '/api/accounts', {
      token: authToken,
      payload: { emailAddress: 'nope', imap: {} },
    })
    expect(res.statusCode).toBe(400)
  })

  it('processes loopback hosts in test mode without persisting on failure', async () => {
    // MAIL_ALLOW_PRIVATE_HOSTS=1 disables the SSRF guard in test environments
    // (blocking itself is covered by ssrf.test.ts). Wrong credentials must
    // still fail cleanly with a mapped error code.
    const before = await inject('GET', '/api/accounts', { token: authToken })
    const countBefore = before.json().accounts.length

    const res = await inject('POST', '/api/accounts', {
      token: authToken,
      payload: {
        emailAddress: 'me@example.com',
        imap: { host: '127.0.0.1', port: 3143, user: 'x', password: 'wrong password 123' },
        smtp: { host: '127.0.0.1', port: 3025, user: 'x', password: 'wrong password 123' },
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().stage).toBe('imap')

    const after = await inject('GET', '/api/accounts', { token: authToken })
    expect(after.json().accounts.length).toBe(countBefore)
  })

  it('creates an account after a successful connection test', async () => {
    const res = await inject('POST', '/api/accounts', {
      token: authToken,
      payload: {
        displayName: 'Test-Konto',
        emailAddress: process.env.GREENMAIL_USER,
        imap: {
          host: greenmailHost,
          port: Number(process.env.GREENMAIL_IMAP_PORT),
          user: process.env.GREENMAIL_USER,
          password: process.env.GREENMAIL_PASSWORD,
        },
        smtp: {
          host: greenmailHost,
          port: Number(process.env.GREENMAIL_SMTP_PORT),
          user: process.env.GREENMAIL_USER,
          password: process.env.GREENMAIL_PASSWORD,
        },
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.account.status).toBe('ok')
    expect(body.account.emailAddress).toBe('testuser@example.com')
    expect(body.test.imap.ok).toBe(true)
    expect(body.test.smtp.ok).toBe(true)
    // Credentials and DEK must never appear anywhere.
    expect(JSON.stringify(body)).not.toContain('secret123')
    expect(JSON.stringify(body)).not.toContain('credential_enc')
    expect(JSON.stringify(body)).not.toContain('wrapped_dek')
  })

  it('refuses wrong credentials with a clear error and persists nothing', async () => {
    const before = await inject('GET', '/api/accounts', { token: authToken })
    const countBefore = before.json().accounts.length

    const res = await inject('POST', '/api/accounts', {
      token: authToken,
      payload: {
        emailAddress: 'me@example.com',
        imap: {
          host: greenmailHost,
          port: Number(process.env.GREENMAIL_IMAP_PORT),
          user: process.env.GREENMAIL_USER,
          password: 'wrong password 123',
        },
        smtp: {
          host: greenmailHost,
          port: Number(process.env.GREENMAIL_SMTP_PORT),
          user: process.env.GREENMAIL_USER,
          password: process.env.GREENMAIL_PASSWORD,
        },
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().stage).toBe('imap')
    expect(res.json().test.code).toBe('AUTH_FAILED')

    const after = await inject('GET', '/api/accounts', { token: authToken })
    expect(after.json().accounts.length).toBe(countBefore) // nothing persisted
  })

  it('lists accounts without credential leakage', async () => {
    const res = await inject('GET', '/api/accounts', { token: authToken })
    expect(res.statusCode).toBe(200)
    const accounts = res.json().accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).not.toHaveProperty('credentialEnc')
    expect(accounts[0]).not.toHaveProperty('wrappedDek')
  })

  it('stores the DEK wrapped and credentials encrypted in the database', async () => {
    const { rows } = await pool.query<{
      wrapped_dek: Buffer
      credential_enc: Buffer
      key_id: string
    }>('SELECT wrapped_dek, credential_enc, key_id FROM mail_account LIMIT 1')
    const row = rows[0]
    expect(row.key_id).toBe(process.env.MASTER_KEY_ID ?? 'v1')
    expect(row.wrapped_dek.toString('utf8')).toContain('fma.k1.')
    expect(row.credential_enc.toString('utf8')).toContain('fma.f1.')
    expect(row.credential_enc.toString('utf8')).not.toContain('secret123')
  })

  it('creates a default identity for the account', async () => {
    const { rows } = await pool.query<{ email_address: string }>(
      'SELECT email_address FROM identity LIMIT 1',
    )
    expect(rows[0]?.email_address).toBe('testuser@example.com')
  })

  it('deletes the account (crypto-shredding)', async () => {
    const list = await inject('GET', '/api/accounts', { token: authToken })
    const id = list.json().accounts[0].id as string

    const res = await inject('DELETE', `/api/accounts/${id}`, { token: authToken })
    expect(res.statusCode).toBe(204)

    const after = await inject('GET', '/api/accounts', { token: authToken })
    expect(after.json().accounts).toHaveLength(0)

    const identities = await pool.query('SELECT * FROM identity')
    expect(identities.rowCount).toBe(0) // cascade

    const wrongUser = await inject('DELETE', `/api/accounts/${id}`, { token: authToken })
    expect(wrongUser.statusCode).toBe(404)
  })
})
