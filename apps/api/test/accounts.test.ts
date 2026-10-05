/**
 * Integration tests for mail account management (roadmap 2.1): create with
 * connection test against a local GreenMail container, list without
 * credential leakage, edit with re-test (roadmap 3.1), delete with
 * crypto-shredding and removal of all account rows.
 *
 * Requires DATABASE_URL (Postgres) and a GreenMail instance:
 *   GREENMAIL_HOST, GREENMAIL_IMAP_PORT, GREENMAIL_SMTP_PORT,
 *   GREENMAIL_USER, GREENMAIL_PASSWORD, MAIL_ALLOW_PRIVATE_HOSTS=1
 *   (MAIL_INSECURE_TRANSPORT=1 comes from vitest.config.ts)
 * CI provides both as service containers; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { decryptField, unwrapAccountKey } from '@fma/crypto'
import { runMigrations } from '@fma/db/migrate'
import { isoDay, utcMidnight } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const greenmailHost = process.env.GREENMAIL_HOST
let app: FastifyInstance
let authToken: string

async function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
    // Many writes from one test IP; rate limits are covered in security.test.ts.
    app = buildApp({ logger: false, rateLimits: [] })
    await runMigrations(pool)
    await pool.query('TRUNCATE session, device, "user", mail_account, identity, job CASCADE')

    // Register the single user and grab a session.
    const setup = await inject('POST', '/api/auth/setup', {
      payload: {
        setupCode: SETUP_CODE,
        email: 'accounts@example.com',
        password: 'correct horse battery',
      },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
  })

  afterAll(async () => {
    await pool.query('TRUNCATE session, device, "user", mail_account, identity, job CASCADE')
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

  it('rejects hosts that are neither a hostname nor an IP literal', async () => {
    for (const host of [
      'imap example.com',
      'https://imap.example.com',
      'imap.example.com:993',
      'imap.example.com/path',
      '-imap.example.com',
      'imap..example.com',
      `${'a'.repeat(64)}.example.com`,
    ]) {
      const res = await inject('POST', '/api/accounts', {
        token: authToken,
        payload: {
          emailAddress: 'x@example.com',
          imap: { host, port: 993, user: 'x', password: 'y' },
          smtp: { host: 'smtp.example.com', port: 465 },
        },
      })
      expect(res.statusCode, host).toBe(400)
    }
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
    expect(body.account.syncSince).toBeNull()
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

  it('lists the INBOX unread count per account', async () => {
    const list = await inject('GET', '/api/accounts', { token: authToken })
    const id = list.json().accounts[0].id as string
    expect(list.json().accounts[0].unreadCount).toBe(0)

    const inbox = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path, special_use) VALUES ($1, 'INBOX', 'inbox') RETURNING id`,
      [id],
    )
    const other = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path) VALUES ($1, 'Projekte') RETURNING id`,
      [id],
    )
    const flagsList = [[], ['\\Seen'], [], ['\\Flagged']]
    for (const [index, flags] of flagsList.entries()) {
      for (const folderId of [inbox.rows[0]!.id, other.rows[0]!.id]) {
        const messageId = randomUUID()
        await pool.query(
          `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
             recipients_enc, snippet_enc)
           VALUES ($1, $2, $3, '\\x00', '\\x00', '\\x00', '\\x00')`,
          [messageId, id, `<${messageId}@x>`],
        )
        await pool.query(
          `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags)
           VALUES ($1, $2, 1, $3, $4)`,
          [messageId, folderId, index + 1, flags],
        )
      }
    }

    const after = await inject('GET', '/api/accounts', { token: authToken })
    // 3 unread in INBOX; unread mail in other folders does not count.
    expect(after.json().accounts[0].unreadCount).toBe(3)
    await pool.query('DELETE FROM message WHERE account_id = $1', [id])
    await pool.query('DELETE FROM folder WHERE account_id = $1', [id])
  })

  it('stores the DEK wrapped and credentials encrypted in the database', async () => {
    const { rows } = await pool.query<{
      wrapped_dek: Buffer
      credential_enc: Buffer
      key_id: string
    }>('SELECT wrapped_dek, credential_enc, key_id FROM mail_account LIMIT 1')
    const row = rows[0]
    if (!row) throw new Error('no mail_account row found')
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

  async function accountId(): Promise<string> {
    const list = await inject('GET', '/api/accounts', { token: authToken })
    return list.json().accounts[0].id as string
  }

  async function storedCredentials(id: string): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ wrapped_dek: Buffer; credential_enc: Buffer }>(
      'SELECT wrapped_dek, credential_enc FROM mail_account WHERE id = $1',
      [id],
    )
    const dek = unwrapAccountKey(process.env.MASTER_KEY!, rows[0]!.wrapped_dek)
    return JSON.parse(
      decryptField(dek, rows[0]!.credential_enc.toString('utf8'), `mail_account.credential:${id}`),
    ) as Record<string, string>
  }

  async function folderSyncJobCount(id: string): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM job WHERE type = 'folder_sync' AND account_id = $1`,
      [id],
    )
    return rows[0]!.count
  }

  it('edits display name and sort order without a connection test', async () => {
    const id = await accountId()
    const jobsBefore = await folderSyncJobCount(id)
    const res = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: { displayName: '  Arbeit  ', sortOrder: 3 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().account.displayName).toBe('Arbeit')
    expect(res.json().account.sortOrder).toBe(3)
    expect(res.json().test).toBeUndefined()
    expect(await folderSyncJobCount(id)).toBe(jobsBefore)
  })

  it('rejects invalid edits and unknown accounts', async () => {
    const id = await accountId()
    const bad = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: { imap: { port: 70000 } },
    })
    expect(bad.statusCode).toBe(400)
    const empty = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: { displayName: '   ' },
    })
    expect(empty.statusCode).toBe(400)
    const unknown = await inject('PATCH', `/api/accounts/${randomUUID()}`, {
      token: authToken,
      payload: { displayName: 'x' },
    })
    expect(unknown.statusCode).toBe(404)
    const invalid = await inject('PATCH', '/api/accounts/not-a-uuid', {
      token: authToken,
      payload: { displayName: 'x' },
    })
    expect(invalid.statusCode).toBe(404)
  })

  it('sets, validates and clears the sync limit (syncSince)', async () => {
    const id = await accountId()
    const today = new Date().toISOString().slice(0, 10)
    const tomorrowPlus = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    for (const syncSince of [tomorrowPlus, '2026-02-30', '30', 30, '2026-01-01T00:00:00Z', '']) {
      const bad = await inject('PATCH', `/api/accounts/${id}`, {
        token: authToken,
        payload: { syncSince },
      })
      expect(bad.statusCode).toBe(400)
    }
    const badCreate = await inject('POST', '/api/accounts', {
      token: authToken,
      payload: {
        emailAddress: 'x@example.com',
        imap: { host: 'imap.example.com', port: 993, user: 'x', password: 'y' },
        smtp: { host: 'smtp.example.com', port: 465 },
        syncSince: tomorrowPlus,
      },
    })
    expect(badCreate.statusCode).toBe(400)

    const jobsBefore = await folderSyncJobCount(id)
    const set = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: { syncSince: '2026-01-15' },
    })
    expect(set.statusCode).toBe(200)
    expect(set.json().account.syncSince).toBe('2026-01-15')
    // A changed limit triggers a sync (a wider period fills the window).
    expect(await folderSyncJobCount(id)).toBe(jobsBefore + 1)
    const listed = (await inject('GET', '/api/accounts', { token: authToken })).json()
    expect(listed.accounts.find((a: { id: string }) => a.id === id).syncSince).toBe('2026-01-15')

    const todayRes = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: { syncSince: today },
    })
    expect(todayRes.json().account.syncSince).toBe(today)
    const cleared = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: { syncSince: null },
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().account.syncSince).toBeNull()
    const unauth = await inject('PATCH', `/api/accounts/${id}`, { payload: { syncSince: null } })
    expect(unauth.statusCode).toBe(401)
  })

  it('keeps the syncSince day in a session TimeZone east of UTC', async () => {
    const id = await accountId()
    const client = await pool.connect()
    try {
      await client.query("SET TimeZone = 'Europe/Berlin'")
      const store = async (value: unknown) =>
        (
          await client.query<{ sync_since: Date }>(
            'UPDATE mail_account SET sync_since = $1 WHERE id = $2 RETURNING sync_since',
            [value, id],
          )
        ).rows[0]!.sync_since
      // The bare day string is read in the session TimeZone (previous UTC day) ...
      expect(isoDay(await store('2026-01-15'))).toBe('2026-01-14')
      // ... UTC midnight (as bound by create/update) keeps the day.
      expect(isoDay(await store(utcMidnight('2026-01-15')))).toBe('2026-01-15')
    } finally {
      await client.query('RESET TimeZone')
      client.release()
    }
    const listed = (await inject('GET', '/api/accounts', { token: authToken })).json()
    expect(listed.accounts.find((a: { id: string }) => a.id === id).syncSince).toBe('2026-01-15')
  })

  it('re-tests changed connection data and saves nothing on failure', async () => {
    const id = await accountId()
    const before = await pool.query<{ credential_enc: Buffer; imap_port: number }>(
      'SELECT credential_enc, imap_port FROM mail_account WHERE id = $1',
      [id],
    )
    const res = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: { imap: { password: 'wrong password 123' } },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().stage).toBe('imap')
    expect(res.json().test.code).toBe('AUTH_FAILED')

    const after = await pool.query<{ credential_enc: Buffer; imap_port: number }>(
      'SELECT credential_enc, imap_port FROM mail_account WHERE id = $1',
      [id],
    )
    expect(after.rows[0]!.credential_enc.equals(before.rows[0]!.credential_enc)).toBe(true)
    expect((await storedCredentials(id)).imapPassword).toBe(process.env.GREENMAIL_PASSWORD)
  })

  it('updates credentials, resets the error state and re-syncs', async () => {
    const id = await accountId()
    await pool.query(
      `UPDATE mail_account SET status = 'auth_error', error_count = 4,
         last_error_code = 'AUTH_FAILED', next_retry_at = now() + interval '1 hour'
       WHERE id = $1`,
      [id],
    )
    // The status display gets code and retry time, never server text.
    const listed = (await inject('GET', '/api/accounts', { token: authToken })).json().accounts[0]
    expect(listed).toMatchObject({ status: 'auth_error', lastErrorCode: 'AUTH_FAILED' })
    expect(Date.parse(listed.nextRetryAt)).toBeGreaterThan(Date.now())
    const before = await pool.query<{ credential_enc: Buffer }>(
      'SELECT credential_enc FROM mail_account WHERE id = $1',
      [id],
    )
    const jobsBefore = await folderSyncJobCount(id)

    const res = await inject('PATCH', `/api/accounts/${id}`, {
      token: authToken,
      payload: {
        imap: {
          host: greenmailHost,
          port: Number(process.env.GREENMAIL_IMAP_PORT),
          user: process.env.GREENMAIL_USER,
          password: process.env.GREENMAIL_PASSWORD,
        },
        // Empty strings: keep the stored SMTP credentials.
        smtp: { user: '', password: '' },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.account).toMatchObject({ status: 'ok', lastErrorCode: null, nextRetryAt: null })
    expect(body.test.imap.ok).toBe(true)
    expect(body.test.smtp.ok).toBe(true)
    expect(JSON.stringify(body)).not.toContain(process.env.GREENMAIL_PASSWORD!)

    const { rows } = await pool.query<{
      status: string
      error_count: number
      next_retry_at: Date | null
      credential_enc: Buffer
    }>(
      'SELECT status, error_count, next_retry_at, credential_enc FROM mail_account WHERE id = $1',
      [id],
    )
    expect(rows[0]).toMatchObject({ status: 'ok', error_count: 0, next_retry_at: null })
    // Re-encrypted (fresh nonce), still the same plaintext.
    expect(rows[0]!.credential_enc.equals(before.rows[0]!.credential_enc)).toBe(false)
    expect(rows[0]!.credential_enc.toString('utf8')).not.toContain(process.env.GREENMAIL_PASSWORD!)
    const creds = await storedCredentials(id)
    expect(creds.imapPassword).toBe(process.env.GREENMAIL_PASSWORD)
    expect(creds.smtpPassword).toBe(process.env.GREENMAIL_PASSWORD)
    expect(await folderSyncJobCount(id)).toBe(jobsBefore + 1)
  })

  it('deletes the account with all its data (crypto-shredding)', async () => {
    const id = await accountId()

    // One row in every account-owned table.
    const folder = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path) VALUES ($1, 'INBOX') RETURNING id`,
      [id],
    )
    const threadId = randomUUID()
    await pool.query('INSERT INTO thread (id, account_id) VALUES ($1, $2)', [threadId, id])
    const messageId = randomUUID()
    await pool.query(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc, thread_id)
       VALUES ($1, $2, '<m@x>', '\\x00', '\\x00', '\\x00', '\\x00', $3)`,
      [messageId, id, threadId],
    )
    await pool.query(
      `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid) VALUES ($1, $2, 1, 1)`,
      [messageId, folder.rows[0]!.id],
    )
    await pool.query(`INSERT INTO message_body (message_id, storage_ref) VALUES ($1, $2)`, [
      messageId,
      `${id}/${messageId}/raw.eml.enc`,
    ])
    await pool.query(
      `INSERT INTO outbox_message (id, account_id, message_id_header) VALUES ($1, $2, '<o@x>')`,
      [randomUUID(), id],
    )
    await pool.query(`INSERT INTO job (type, account_id) VALUES ('message_sync', $1)`, [id])

    const res = await inject('DELETE', `/api/accounts/${id}`, { token: authToken })
    expect(res.statusCode).toBe(204)

    const after = await inject('GET', '/api/accounts', { token: authToken })
    expect(after.json().accounts).toHaveLength(0)

    for (const [table, where] of [
      ['mail_account', 'id = $1'],
      ['identity', 'account_id = $1'],
      ['folder', 'account_id = $1'],
      ['thread', 'account_id = $1'],
      ['message', 'account_id = $1'],
      ['outbox_message', 'account_id = $1'],
      ['job', 'account_id = $1'],
    ] as const) {
      const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE ${where}`, [id])
      expect(rowCount, table).toBe(0)
    }
    const locations = await pool.query('SELECT 1 FROM message_location WHERE message_id = $1', [
      messageId,
    ])
    expect(locations.rowCount).toBe(0)
    const bodies = await pool.query('SELECT 1 FROM message_body WHERE message_id = $1', [messageId])
    expect(bodies.rowCount).toBe(0)

    // Volume cleanup is handed to the worker with the id only.
    const cleanup = await pool.query<{ account_id: string | null; payload: unknown }>(
      `SELECT account_id, payload FROM job WHERE type = 'account_cleanup'`,
    )
    expect(cleanup.rows).toEqual([{ account_id: null, payload: { accountId: id } }])

    const again = await inject('DELETE', `/api/accounts/${id}`, { token: authToken })
    expect(again.statusCode).toBe(404)
  })
})
