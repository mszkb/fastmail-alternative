/**
 * Integration tests for the drafts API (roadmap 2.8): create/update via
 * PUT with client ids, encryption at rest, ownership (404 for foreign
 * ids), version conflicts between devices (409, force), delete and send
 * (soft delete + coalesced draft_sync job), and opening a message of the
 * Drafts folder for editing. Requires DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { runMigrations } from '@fma/db/migrate'
import {
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { Draft, DraftConflictResponse, DraftListResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, outbox_message, draft'

let app: FastifyInstance
let authToken: string

async function createAccount(userId: string, email: string): Promise<{ id: string; dek: Buffer }> {
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
  return { id, dek }
}

function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

async function draftJobs(draftId: string) {
  const { rows } = await pool.query<{ state: string; delayed: boolean }>(
    `SELECT state, run_at > now() + interval '5 seconds' AS delayed FROM job
     WHERE type = 'draft_sync' AND payload->>'draftId' = $1`,
    [draftId],
  )
  return rows
}

describe.skipIf(!databaseUrl)('drafts api', () => {
  let account: { id: string; dek: Buffer }
  let foreign: { id: string; dek: Buffer }
  let draftsFolderId: string

  const content = () => ({
    accountId: account.id,
    to: 'Alice <alice@example.com>, bob@exa',
    cc: '',
    bcc: 'hidden@example.net',
    subject: 'Geheimer Entwurf',
    text: 'Streng vertraulicher Entwurfstext.',
  })

  beforeAll(async () => {
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { email: 'drafts@example.com', password: 'correct horse battery' },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    account = await createAccount(rows[0]!.id, 'me@example.com')
    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other@example.com', 'x') RETURNING id`,
    )
    foreign = await createAccount(other.rows[0]!.id, 'other@example.com')
    const folder = await pool.query<{ id: string }>(
      `INSERT INTO folder (account_id, path, delimiter, special_use, uidvalidity)
       VALUES ($1, 'Drafts', '/', 'drafts', 7) RETURNING id`,
      [account.id],
    )
    draftsFolderId = folder.rows[0]!.id
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM job')
    await pool.query('DELETE FROM draft')
    await pool.query('DELETE FROM outbox_message')
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
  })

  it('requires authentication', async () => {
    const id = randomUUID()
    expect((await request('PUT', `/api/drafts/${id}`, content(), null)).statusCode).toBe(401)
    expect(
      (await request('GET', `/api/accounts/${account.id}/drafts`, undefined, null)).statusCode,
    ).toBe(401)
  })

  it('creates a draft encrypted at rest and enqueues one delayed IMAP upload', async () => {
    const id = randomUUID()
    const res = await request('PUT', `/api/drafts/${id}`, {
      ...content(),
      inReplyTo: '<parent@example.com>',
      references: ['<parent@example.com>'],
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<Draft>()).toMatchObject({
      id,
      accountId: account.id,
      version: 1,
      to: 'Alice <alice@example.com>, bob@exa',
      bcc: 'hidden@example.net',
      subject: 'Geheimer Entwurf',
      inReplyTo: '<parent@example.com>',
      messageIds: [],
    })

    const { rows } = await pool.query<{ dump: string; content: string }>(
      `SELECT row_to_json(d)::text AS dump, convert_from(content_enc, 'UTF8') AS content
       FROM draft d WHERE id = $1`,
      [id],
    )
    for (const secret of ['Geheimer', 'vertraulicher', 'alice@', 'hidden@']) {
      expect(rows[0]!.dump).not.toContain(secret)
    }
    expect(rows[0]!.content).toMatch(/^fma\.f1\./)

    // Autosaves in a burst share one queued (delayed) upload job.
    for (let i = 0; i < 3; i++) {
      const update = await request('PUT', `/api/drafts/${id}`, {
        ...content(),
        text: `Fassung ${i}`,
        baseVersion: i + 1,
      })
      expect(update.statusCode).toBe(200)
      expect(update.json<Draft>().version).toBe(i + 2)
    }
    expect(await draftJobs(id)).toEqual([{ state: 'queued', delayed: true }])

    // Survives a "device change": another read returns the latest version.
    const read = await request('GET', `/api/drafts/${id}`)
    expect(read.json<Draft>()).toMatchObject({ version: 4, text: 'Fassung 2' })
    const list = await request('GET', `/api/accounts/${account.id}/drafts`)
    expect(list.json<DraftListResponse>().drafts.map((d) => d.id)).toEqual([id])
  })

  it('answers 409 with the current draft on a stale version, unless forced', async () => {
    const id = randomUUID()
    await request('PUT', `/api/drafts/${id}`, content())
    // Device A saves version 2.
    await request('PUT', `/api/drafts/${id}`, { ...content(), text: 'Gerät A', baseVersion: 1 })
    // Device B still edits version 1.
    const stale = await request('PUT', `/api/drafts/${id}`, {
      ...content(),
      text: 'Gerät B',
      baseVersion: 1,
    })
    expect(stale.statusCode).toBe(409)
    const conflict = stale.json<DraftConflictResponse>()
    expect(conflict.draft).toMatchObject({ version: 2, text: 'Gerät A' })

    const forced = await request('PUT', `/api/drafts/${id}`, {
      ...content(),
      text: 'Gerät B',
      baseVersion: 1,
      force: true,
    })
    expect(forced.statusCode).toBe(200)
    expect(forced.json<Draft>()).toMatchObject({ version: 3, text: 'Gerät B' })
  })

  it('validates input', async () => {
    const id = randomUUID()
    expect(
      (await request('PUT', `/api/drafts/${id}`, { ...content(), subject: 1 })).statusCode,
    ).toBe(400)
    expect(
      (await request('PUT', `/api/drafts/${id}`, { ...content(), inReplyTo: 'kaputt' })).statusCode,
    ).toBe(400)
    expect((await request('PUT', '/api/drafts/not-a-uuid', content())).statusCode).toBe(404)
  })

  it('isolates drafts of other users (404) and never overwrites them', async () => {
    const id = randomUUID()
    await pool.query(`INSERT INTO draft (id, account_id, content_enc) VALUES ($1, $2, NULL)`, [
      id,
      foreign.id,
    ])
    expect((await request('GET', `/api/drafts/${id}`)).statusCode).toBe(404)
    expect((await request('PUT', `/api/drafts/${id}`, content())).statusCode).toBe(404)
    expect((await request('DELETE', `/api/drafts/${id}`)).statusCode).toBe(404)
    expect(
      (await request('PUT', `/api/drafts/${randomUUID()}`, { ...content(), accountId: foreign.id }))
        .statusCode,
    ).toBe(404)
    expect((await request('GET', `/api/accounts/${foreign.id}/drafts`)).statusCode).toBe(404)
    const { rows } = await pool.query('SELECT deleted_at, version FROM draft WHERE id = $1', [id])
    expect(rows[0]).toEqual({ deleted_at: null, version: 1 })
  })

  it('deletes a draft (idempotent) and never recreates it from a late save', async () => {
    const id = randomUUID()
    await request('PUT', `/api/drafts/${id}`, content())
    await pool.query('DELETE FROM job')
    expect((await request('DELETE', `/api/drafts/${id}`)).statusCode).toBe(204)
    expect((await request('DELETE', `/api/drafts/${id}`)).statusCode).toBe(204)
    expect((await request('DELETE', `/api/drafts/${randomUUID()}`)).statusCode).toBe(204)
    expect((await request('GET', `/api/drafts/${id}`)).statusCode).toBe(404)
    // The upload job removes the IMAP copy right away.
    expect(await draftJobs(id)).toEqual([{ state: 'queued', delayed: false }])
    const { rows } = await pool.query<{ content_enc: Buffer | null }>(
      'SELECT content_enc FROM draft WHERE id = $1',
      [id],
    )
    expect(rows[0]!.content_enc).toBeNull()

    // A late autosave of the discarded draft: 410, also once the row is gone.
    const late = { ...content(), baseVersion: 1, force: true }
    expect((await request('PUT', `/api/drafts/${id}`, late)).statusCode).toBe(410)
    await pool.query('DELETE FROM draft WHERE id = $1', [id])
    expect((await request('PUT', `/api/drafts/${id}`, late)).statusCode).toBe(410)
  })

  it('deletes the draft when it is sent', async () => {
    const id = randomUUID()
    await request('PUT', `/api/drafts/${id}`, content())
    await pool.query('DELETE FROM job')
    const sent = await request('POST', '/api/outbox', {
      accountId: account.id,
      to: ['alice@example.com'],
      subject: 'Geheimer Entwurf',
      text: 'Fertig.',
      draftId: id,
    })
    expect(sent.statusCode).toBe(201)
    expect((await request('GET', `/api/drafts/${id}`)).statusCode).toBe(404)
    expect(await draftJobs(id)).toEqual([{ state: 'queued', delayed: false }])

    // Unknown draft ids do not block sending.
    const other = await request('POST', '/api/outbox', {
      accountId: account.id,
      to: ['alice@example.com'],
      subject: 'x',
      text: 'y',
      draftId: randomUUID(),
    })
    expect(other.statusCode).toBe(201)
  })

  it('opens a message of the Drafts folder for editing', async () => {
    const messageId = randomUUID()
    const enc = (field: Parameters<typeof messageFieldAad>[0], value: string) =>
      Buffer.from(encryptField(account.dek, value, messageFieldAad(field, messageId)), 'utf8')
    await pool.query(
      `INSERT INTO message
         (id, account_id, message_id_header, in_reply_to, subject_enc, from_enc, recipients_enc,
          snippet_enc, sent_at, "references")
       VALUES ($1, $2, '<thunderbird-draft@example.com>', '<orig@example.com>', $3, $4, $5, $6,
               now(), '{<orig@example.com>}')`,
      [
        messageId,
        account.id,
        enc('subject', 'Entwurf aus Thunderbird'),
        enc('from', JSON.stringify([{ name: 'Ich', address: 'me@example.com' }])),
        enc(
          'recipients',
          JSON.stringify({ to: [{ name: 'Anna', address: 'anna@example.com' }], cc: [] }),
        ),
        enc('snippet', 'Halbfertig'),
      ],
    )
    await pool.query(
      `INSERT INTO message_location (message_id, folder_id, uidvalidity, uid) VALUES ($1, $2, 7, 42)`,
      [messageId, draftsFolderId],
    )
    await pool.query(
      `INSERT INTO message_body (message_id, storage_ref, text_plain_enc) VALUES ($1, 'x', $2)`,
      [messageId, enc('text', 'Halbfertiger Text')],
    )

    const opened = await request('POST', `/api/messages/${messageId}/draft`)
    expect(opened.statusCode).toBe(201)
    const draft = opened.json<Draft>()
    expect(draft).toMatchObject({
      to: 'Anna <anna@example.com>',
      subject: 'Entwurf aus Thunderbird',
      text: 'Halbfertiger Text',
      inReplyTo: '<orig@example.com>',
      references: ['<orig@example.com>'],
      version: 1,
      messageIds: [messageId],
    })
    const { rows } = await pool.query(
      `SELECT source_folder_id, source_uidvalidity, source_uid, imap_version FROM draft WHERE id = $1`,
      [draft.id],
    )
    expect(rows[0]).toEqual({
      source_folder_id: draftsFolderId,
      source_uidvalidity: '7',
      source_uid: '42',
      imap_version: 1,
    })
    // Not uploaded before it is edited.
    expect(await draftJobs(draft.id)).toEqual([])

    // Opening it again resumes the same draft.
    const again = await request('POST', `/api/messages/${messageId}/draft`)
    expect(again.statusCode).toBe(200)
    expect(again.json<Draft>().id).toBe(draft.id)

    // Our own uploaded copies map back to their draft via the Message-ID.
    const ownId = randomUUID()
    await request('PUT', `/api/drafts/${ownId}`, content())
    const copyId = randomUUID()
    await pool.query(
      `INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc,
         recipients_enc, snippet_enc)
       VALUES ($1, $2, $3, '\\x00', '\\x00', '\\x00', '\\x00')`,
      [copyId, account.id, `<${ownId}.1@example.com>`],
    )
    const own = await request('POST', `/api/messages/${copyId}/draft`)
    expect(own.statusCode).toBe(200)
    expect(own.json<Draft>().id).toBe(ownId)

    // Foreign or unknown messages: 404.
    expect((await request('POST', `/api/messages/${randomUUID()}/draft`)).statusCode).toBe(404)
  })
})
