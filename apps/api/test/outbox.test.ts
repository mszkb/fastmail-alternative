/**
 * Integration tests for the sending API (roadmap 2.7): validation,
 * ownership (404 for foreign ids), encryption at rest, the enqueued
 * send_message job, status/error reporting and retry. Requires
 * DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import { encryptField, generateDataKey, loadMasterKey, wrapDataKey } from '@fma/crypto'
import type { OutboxListResponse, OutboxMessage } from '@fma/shared'
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
  return id
}

async function createIdentity(accountId: string, name: string, email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO identity (account_id, name, email_address) VALUES ($1, $2, $3) RETURNING id`,
    [accountId, name, email],
  )
  return rows[0]!.id
}

function request(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  token: string | null = authToken,
) {
  return app.inject({
    method,
    url,
    payload,
    headers: token ? { cookie: `fma_session=${token}` } : {},
  })
}

describe.skipIf(!databaseUrl)('outbox api', () => {
  let accountId: string
  let aliasIdentityId: string
  let foreignAccountId: string
  let foreignIdentityId: string

  const valid = () => ({
    accountId,
    to: ['alice@example.com', { name: 'Bob Beispiel', address: 'bob@example.org' }],
    cc: [],
    bcc: ['hidden@example.net'],
    subject: 'Geheimer Betreff',
    text: 'Streng vertraulicher Inhalt.',
  })

  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'outbox@example.com', password: 'correct horse battery' },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    accountId = await createAccount(rows[0]!.id, 'me@example.com')
    await createIdentity(accountId, 'Ich Selbst', 'me@example.com')
    aliasIdentityId = await createIdentity(accountId, 'Alias', 'alias@example.com')

    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other@example.com', 'x') RETURNING id`,
    )
    foreignAccountId = await createAccount(other.rows[0]!.id, 'other@example.com')
    foreignIdentityId = await createIdentity(foreignAccountId, 'Other', 'other@example.com')
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM job')
    await pool.query('DELETE FROM outbox_message')
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires authentication', async () => {
    expect((await request('POST', '/api/outbox', valid(), null)).statusCode).toBe(401)
    expect((await request('GET', `/api/outbox/${randomUUID()}`, undefined, null)).statusCode).toBe(
      401,
    )
  })

  it('queues a message encrypted at rest and enqueues a send_message job', async () => {
    const res = await request('POST', '/api/outbox', {
      ...valid(),
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<parent@example.com>'],
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<OutboxMessage>()
    expect(body).toMatchObject({
      accountId,
      status: 'queued',
      subject: 'Geheimer Betreff',
      from: { name: 'Ich Selbst', address: 'me@example.com' },
      to: [
        { name: '', address: 'alice@example.com' },
        { name: 'Bob Beispiel', address: 'bob@example.org' },
      ],
      bcc: [{ name: '', address: 'hidden@example.net' }],
      attempts: 0,
      error: null,
      sentAt: null,
    })
    expect(body.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/)

    // Nothing readable in the database: no subject, body or recipients.
    const { rows } = await pool.query(
      `SELECT row_to_json(o)::text AS dump, in_reply_to, "references"
       FROM outbox_message o WHERE id = $1`,
      [body.id],
    )
    const stored = rows[0] as { dump: string; in_reply_to: string; references: string[] }
    for (const secret of ['Geheimer', 'vertraulicher', 'alice@', 'hidden@', 'Bob']) {
      expect(stored.dump).not.toContain(secret)
    }
    const raw = await pool.query<{ content: string }>(
      `SELECT convert_from(content_enc, 'UTF8') AS content FROM outbox_message WHERE id = $1`,
      [body.id],
    )
    expect(raw.rows[0]!.content).toMatch(/^fma\.f1\./)
    expect(stored.in_reply_to).toBe('<parent@example.com>')
    expect(stored.references).toEqual(['<root@example.com>', '<parent@example.com>'])

    const { rows: jobs } = await pool.query(
      `SELECT type, account_id::text, payload FROM job ORDER BY id`,
    )
    expect(jobs).toEqual([
      { type: 'send_message', account_id: accountId, payload: { outboxId: body.id } },
    ])

    // Status endpoint returns the same, decrypted.
    const status = await request('GET', `/api/outbox/${body.id}`)
    expect(status.statusCode).toBe(200)
    expect(status.json<OutboxMessage>().subject).toBe('Geheimer Betreff')
  })

  it('uses the requested identity as sender', async () => {
    const res = await request('POST', '/api/outbox', { ...valid(), identityId: aliasIdentityId })
    expect(res.statusCode).toBe(201)
    const body = res.json<OutboxMessage>()
    expect(body.from).toEqual({ name: 'Alias', address: 'alias@example.com' })
    expect(body.identityId).toBe(aliasIdentityId)
  })

  it('rejects invalid messages with 400', async () => {
    const tooMany = Array.from({ length: 101 }, (_, n) => `r${n}@example.com`)
    for (const body of [
      {},
      { ...valid(), accountId: 'nope' },
      { ...valid(), to: [], bcc: [] },
      { ...valid(), to: ['not-an-address'] },
      { ...valid(), to: ['a@example.com\r\nBcc: evil@example.com'] },
      { ...valid(), to: [{ name: 'x' }] },
      { ...valid(), to: tooMany },
      { ...valid(), subject: undefined },
      { ...valid(), subject: 'x'.repeat(999) },
      { ...valid(), text: 42 },
      { ...valid(), identityId: 'nope' },
      { ...valid(), inReplyTo: 'no-brackets@example.com' },
      { ...valid(), references: ['<ok@example.com>', '<bad id@example.com>'] },
    ]) {
      const res = await request('POST', '/api/outbox', body as Record<string, unknown>)
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(res.json().message).toBeTruthy()
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox_message')
    expect(rows[0]).toEqual({ n: 0 })
  })

  it('strips line breaks from the subject', async () => {
    const res = await request('POST', '/api/outbox', {
      ...valid(),
      subject: 'Hallo\r\nBcc: evil@example.com',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<OutboxMessage>().subject).toBe('Hallo Bcc: evil@example.com')
  })

  it('answers 404 for foreign accounts, identities and outbox entries', async () => {
    expect(
      (await request('POST', '/api/outbox', { ...valid(), accountId: foreignAccountId }))
        .statusCode,
    ).toBe(404)
    expect(
      (await request('POST', '/api/outbox', { ...valid(), identityId: foreignIdentityId }))
        .statusCode,
    ).toBe(404)
    expect((await request('GET', `/api/accounts/${foreignAccountId}/outbox`)).statusCode).toBe(404)
    expect((await request('GET', '/api/accounts/nope/outbox')).statusCode).toBe(404)
    expect((await request('GET', '/api/outbox/nope')).statusCode).toBe(404)

    // Outbox entry of another user.
    const foreignId = randomUUID()
    await pool.query(
      `INSERT INTO outbox_message (id, account_id, status, message_id_header)
       VALUES ($1, $2, 'failed', '<x@example.com>')`,
      [foreignId, foreignAccountId],
    )
    expect((await request('GET', `/api/outbox/${foreignId}`)).statusCode).toBe(404)
    expect((await request('POST', `/api/outbox/${foreignId}/retry`)).statusCode).toBe(404)
    const { rows } = await pool.query('SELECT status FROM outbox_message WHERE id = $1', [
      foreignId,
    ])
    expect(rows[0]).toEqual({ status: 'failed' })
  })

  it('lists pending and failed messages with error details, and retries failed ones', async () => {
    const queued = (await request('POST', '/api/outbox', valid())).json<OutboxMessage>()
    const failed = (
      await request('POST', '/api/outbox', { ...valid(), subject: 'Fehlgeschlagen' })
    ).json<OutboxMessage>()
    const sent = (await request('POST', '/api/outbox', valid())).json<OutboxMessage>()
    await pool.query(
      `UPDATE outbox_message SET status = 'failed', attempts = 5, last_error_code = 'AUTH_FAILED'
       WHERE id = $1`,
      [failed.id],
    )
    await pool.query(
      `UPDATE outbox_message SET status = 'sent', sent_at = now(), sent_copy = 'done',
         content_enc = NULL
       WHERE id = $1`,
      [sent.id],
    )

    const list = await request('GET', `/api/accounts/${accountId}/outbox`)
    expect(list.statusCode).toBe(200)
    const messages = list.json<OutboxListResponse>().messages
    expect(messages.map((m) => m.id).sort()).toEqual([queued.id, failed.id].sort())
    const failedEntry = messages.find((m) => m.id === failed.id)!
    expect(failedEntry.subject).toBe('Fehlgeschlagen')
    expect(failedEntry.error).toEqual({
      code: 'AUTH_FAILED',
      message: 'Der SMTP-Server hat die Zugangsdaten abgelehnt.',
    })

    // Sent: status only, content is gone.
    const sentStatus = (await request('GET', `/api/outbox/${sent.id}`)).json<OutboxMessage>()
    expect(sentStatus).toMatchObject({ status: 'sent', subject: null, sentCopy: 'done' })
    expect(sentStatus.sentAt).not.toBeNull()

    // Retry: only failed messages; re-queues with a new job.
    await pool.query('DELETE FROM job')
    expect((await request('POST', `/api/outbox/${queued.id}/retry`)).statusCode).toBe(409)
    expect((await request('POST', `/api/outbox/${sent.id}/retry`)).statusCode).toBe(409)
    const retried = await request('POST', `/api/outbox/${failed.id}/retry`)
    expect(retried.statusCode).toBe(200)
    expect(retried.json<OutboxMessage>()).toMatchObject({ status: 'queued', error: null })
    const { rows: jobs } = await pool.query(`SELECT type, payload FROM job`)
    expect(jobs).toEqual([{ type: 'send_message', payload: { outboxId: failed.id } }])
    expect((await request('POST', `/api/outbox/${failed.id}/retry`)).statusCode).toBe(409)
  })
  it('is idempotent per clientId (offline queue replay sends once)', async () => {
    const clientId = randomUUID()
    const first = await request('POST', '/api/outbox', { ...valid(), clientId })
    expect(first.statusCode).toBe(201)
    const created = first.json<OutboxMessage>()

    // Replay (sequential and concurrent): same entry, no second job.
    const again = await request('POST', '/api/outbox', { ...valid(), clientId })
    expect(again.statusCode).toBe(200)
    expect(again.json<OutboxMessage>()).toMatchObject({ id: created.id, status: 'queued' })
    const concurrent = await Promise.all([
      request('POST', '/api/outbox', { ...valid(), clientId: clientId.toUpperCase() }),
      request('POST', '/api/outbox', { ...valid(), clientId }),
    ])
    expect(concurrent.map((r) => r.statusCode)).toEqual([200, 200])
    expect(concurrent.every((r) => r.json<OutboxMessage>().id === created.id)).toBe(true)
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM outbox_message`)
    expect(rows[0].n).toBe(1)
    const { rows: jobs } = await pool.query(`SELECT count(*)::int AS n FROM job`)
    expect(jobs[0].n).toBe(1)

    // Concurrent first submissions race on the unique index: one wins.
    const fresh = randomUUID()
    const race = await Promise.all([
      request('POST', '/api/outbox', { ...valid(), clientId: fresh }),
      request('POST', '/api/outbox', { ...valid(), clientId: fresh }),
    ])
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 201])
    expect(race[0]!.json<OutboxMessage>().id).toBe(race[1]!.json<OutboxMessage>().id)

    // Without a clientId every request is a new message; invalid ids are refused.
    expect((await request('POST', '/api/outbox', valid())).statusCode).toBe(201)
    expect((await request('POST', '/api/outbox', { ...valid(), clientId: 'x' })).statusCode).toBe(
      400,
    )
    // The same clientId on another (foreign) account does not reveal the entry.
    const foreign = await request('POST', '/api/outbox', {
      ...valid(),
      accountId: foreignAccountId,
      clientId,
    })
    expect(foreign.statusCode).toBe(404)
  })
})
