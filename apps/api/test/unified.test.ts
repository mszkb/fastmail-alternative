/**
 * Integration tests for the optional unified inbox (roadmap 3.7): off by
 * default (404), opt-in via /api/settings, INBOX messages of all accounts of
 * the user sorted by date with account assignment, no foreign messages and
 * stable keyset pagination. Requires DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import {
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { UnifiedMessageListResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body'

let app: FastifyInstance
let authToken: string

async function get(url: string, token?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: token ? { cookie: `fma_session=${token}` } : {},
  })
}

async function createAccount(userId: string): Promise<{ id: string; dek: Buffer }> {
  const id = randomUUID()
  const dek = generateDataKey()
  const wrapped = wrapDataKey(loadMasterKey(process.env.MASTER_KEY!), dek, 'v1')
  await pool.query(
    `INSERT INTO mail_account
       (id, user_id, display_name, email_address, imap_host, imap_port,
        smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status)
     VALUES ($1, $2, 'Test', $3, 'imap.test', 993, 'smtp.test', 465, $4, 'v1', $5, 'ok')`,
    [
      id,
      userId,
      `${id}@example.com`,
      Buffer.from(wrapped, 'utf8'),
      Buffer.from(encryptField(dek, '{}', `mail_account.credential:${id}`), 'utf8'),
    ],
  )
  return { id, dek }
}

async function createFolder(
  accountId: string,
  path: string,
  specialUse: string | null = null,
  delimiter = '/',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO folder (account_id, path, delimiter, special_use, uidvalidity)
     VALUES ($1, $2, $3, $4, 1) RETURNING id`,
    [accountId, path, delimiter, specialUse],
  )
  return rows[0]!.id
}

let uidCounter = 1

async function createMessage(
  account: { id: string; dek: Buffer },
  folderId: string,
  opts: {
    subject: string
    sentAt: string | null
    flags?: string[]
    text?: string
    from?: { name: string; address: string }
    replyTo?: { name: string; address: string }[]
    messageIdHeader?: string
    references?: string[]
  },
): Promise<string> {
  const id = randomUUID()
  const enc = (field: Parameters<typeof messageFieldAad>[0], value: string) =>
    Buffer.from(encryptField(account.dek, value, messageFieldAad(field, id)), 'utf8')
  await pool.query(
    `INSERT INTO message
       (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc,
        snippet_enc, sent_at, received_at, has_attachments, "references")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2020-01-01T00:00:00Z', false, $9)`,
    [
      id,
      account.id,
      opts.messageIdHeader ?? `<${id}@test>`,
      enc('subject', opts.subject),
      enc('from', JSON.stringify([opts.from ?? { name: 'Alice', address: 'alice@example.com' }])),
      enc(
        'recipients',
        JSON.stringify({
          to: [{ name: 'Bob', address: 'bob@example.com' }],
          cc: [{ name: '', address: 'carol@example.com' }],
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        }),
      ),
      enc('snippet', `Snippet of ${opts.subject}`),
      opts.sentAt,
      opts.references ?? [],
    ],
  )
  await pool.query(
    `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags)
     VALUES ($1, $2, 1, $3, $4)`,
    [id, folderId, uidCounter++, opts.flags ?? []],
  )
  if (opts.text !== undefined) {
    await pool.query(
      `INSERT INTO message_body (message_id, storage_ref, text_plain_enc)
       VALUES ($1, $2, $3)`,
      [id, `${account.id}/${id}/raw.eml.enc`, enc('text', opts.text)],
    )
  }
  return id
}

describe.skipIf(!databaseUrl)('unified inbox', () => {
  let a: { id: string; dek: Buffer }
  let b: { id: string; dek: Buffer }
  let inboxA: string
  let inboxB: string

  async function put(unifiedInbox: unknown) {
    return app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { cookie: `fma_session=${authToken}` },
      payload: { unifiedInbox },
    })
  }

  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        setupCode: SETUP_CODE,
        email: 'unified@example.com',
        password: 'correct horse battery',
      },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    a = await createAccount(rows[0]!.id)
    b = await createAccount(rows[0]!.id)
    inboxA = await createFolder(a.id, 'INBOX')
    inboxB = await createFolder(b.id, 'Inbox')
    const archiveA = await createFolder(a.id, 'Archive', 'archive')

    await createMessage(a, inboxA, { subject: 'A1', sentAt: '2026-03-01T10:00:00Z' })
    await createMessage(b, inboxB, { subject: 'B1', sentAt: '2026-03-02T10:00:00Z' })
    await createMessage(a, inboxA, { subject: 'A2', sentAt: '2026-03-03T10:00:00Z' })
    await createMessage(b, inboxB, { subject: 'B2', sentAt: '2026-03-04T10:00:00Z' })
    await createMessage(a, inboxA, { subject: 'A3', sentAt: '2026-03-05T10:00:00Z' })
    await createMessage(a, archiveA, { subject: 'Archived', sentAt: '2026-03-06T10:00:00Z' })

    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash, unified_inbox_enabled)
       VALUES ('other@example.com', 'x', true) RETURNING id`,
    )
    const foreign = await createAccount(other.rows[0]!.id)
    const foreignInbox = await createFolder(foreign.id, 'INBOX')
    await createMessage(foreign, foreignInbox, {
      subject: 'Foreign',
      sentAt: '2026-03-07T10:00:00Z',
    })
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires authentication', async () => {
    expect((await get('/api/settings')).statusCode).toBe(401)
    expect((await get('/api/unified/inbox')).statusCode).toBe(401)
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { unifiedInbox: true },
    })
    expect(res.statusCode).toBe(401)
  })

  it('is off by default and answers 404 while off', async () => {
    const settings = await get('/api/settings', authToken)
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toEqual({ unifiedInbox: false })
    expect((await get('/api/unified/inbox', authToken)).statusCode).toBe(404)
  })

  it('rejects invalid settings', async () => {
    expect((await put('yes')).statusCode).toBe(400)
    expect((await get('/api/settings', authToken)).json()).toEqual({ unifiedInbox: false })
  })

  it('lists the INBOX messages of all own accounts sorted by date', async () => {
    const enabled = await put(true)
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toEqual({ unifiedInbox: true })

    const res = await get('/api/unified/inbox', authToken)
    expect(res.statusCode).toBe(200)
    const body = res.json<UnifiedMessageListResponse>()
    expect(body.messages.map((m) => m.subject)).toEqual(['A3', 'B2', 'A2', 'B1', 'A1'])
    expect(body.messages.map((m) => m.accountId)).toEqual([a.id, b.id, a.id, b.id, a.id])
    expect(body.messages.map((m) => m.folderId)).toEqual([inboxA, inboxB, inboxA, inboxB, inboxA])
    expect(body.messages[0]!.snippet).toBe('Snippet of A3')
    expect(body.messages[0]!.from?.address).toBe('alice@example.com')
    expect(body.nextCursor).toBeNull()
    expect(res.body).not.toContain('Foreign')
    expect(res.body).not.toContain('Archived')
  })

  it('paginates stably while new mail arrives', async () => {
    const first = (
      await get('/api/unified/inbox?limit=2', authToken)
    ).json<UnifiedMessageListResponse>()
    expect(first.messages.map((m) => m.subject)).toEqual(['A3', 'B2'])
    expect(first.nextCursor).not.toBeNull()
    await createMessage(b, inboxB, { subject: 'New', sentAt: '2026-03-08T10:00:00Z' })
    const second = (
      await get(`/api/unified/inbox?limit=2&cursor=${first.nextCursor}`, authToken)
    ).json<UnifiedMessageListResponse>()
    expect(second.messages.map((m) => m.subject)).toEqual(['A2', 'B1'])
    const third = (
      await get(`/api/unified/inbox?limit=2&cursor=${second.nextCursor}`, authToken)
    ).json<UnifiedMessageListResponse>()
    expect(third.messages.map((m) => m.subject)).toEqual(['A1'])
    expect(third.nextCursor).toBeNull()
    expect((await get('/api/unified/inbox?cursor=bogus', authToken)).statusCode).toBe(400)
  })

  it('answers 404 again after switching it off', async () => {
    expect((await put(false)).json()).toEqual({ unifiedInbox: false })
    expect((await get('/api/unified/inbox', authToken)).statusCode).toBe(404)
  })
})
