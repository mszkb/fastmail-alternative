/**
 * Integration tests for attachments (roadmap 5.3): listing and streaming
 * received attachments out of the encrypted raw mail (bytes, safe headers,
 * no inline delivery of active content), uploads for sending (encrypted at
 * rest, size limit, ownership) and binding them in POST /api/outbox.
 * Requires DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import MailComposer from 'nodemailer/lib/mail-composer'
import { runMigrations } from '@fma/db/migrate'
import {
  decryptBytes,
  decryptField,
  encryptBytes,
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  uploadFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type {
  AttachmentMissingResponse,
  CopyAttachmentsResponse,
  Draft,
  MessageAttachmentListResponse,
  UploadedAttachment,
} from '@fma/shared'
import { buildApp } from '../src/app'
import {
  COPY_ADMISSION_WEIGHT,
  MAX_DRAFT_UPLOADS,
  MAX_PENDING_UPLOADS,
  tryAdmitUpload,
} from '../src/mail/attachments'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, outbox_message, attachment_upload, draft'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

let app: FastifyInstance
let authToken: string
let dataDir: string

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

/**
 * Stores a message whose raw source is written encrypted like the worker
 * does (binary format; `legacy`: the text format used before).
 */
async function createMessage(
  account: { id: string; dek: Buffer },
  raw: Buffer | null,
  legacy = false,
): Promise<string> {
  const id = randomUUID()
  const enc = (field: Parameters<typeof messageFieldAad>[0], value: string) =>
    Buffer.from(encryptField(account.dek, value, messageFieldAad(field, id)), 'utf8')
  await pool.query(
    `INSERT INTO message
       (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc,
        snippet_enc, received_at, has_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), false)`,
    [
      id,
      account.id,
      `<${id}@test>`,
      enc('subject', 'Anhang'),
      enc('from', '[]'),
      enc('recipients', '{}'),
      enc('snippet', ''),
    ],
  )
  if (raw) {
    const ref = path.join(account.id, id, 'raw.eml.enc')
    await mkdir(path.join(dataDir, account.id, id), { recursive: true })
    await writeFile(
      path.join(dataDir, ref),
      legacy
        ? Buffer.from(
            encryptField(account.dek, raw.toString('latin1'), messageFieldAad('body', id)),
            'utf8',
          )
        : encryptBytes(account.dek, raw, messageFieldAad('body', id)),
    )
    await pool.query(
      `INSERT INTO message_body (message_id, storage_ref, text_plain_enc) VALUES ($1, $2, $3)`,
      [id, ref, enc('text', 'plain')],
    )
  }
  return id
}

function compose(options: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> {
  return new MailComposer({
    from: 'shop@example.com',
    to: 'me@example.com',
    subject: 'Newsletter',
    ...options,
  })
    .compile()
    .build()
}

function upload(
  accountId: string,
  body: Buffer,
  filename: string,
  type: string,
  token = authToken,
) {
  return app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/uploads`,
    payload: body,
    headers: {
      cookie: `fma_session=${token}`,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(filename),
      'x-content-type': type,
    },
  })
}

describe.skipIf(!databaseUrl)('attachments api', () => {
  let account: { id: string; dek: Buffer }
  let messageId: string
  const pdf = randomBytes(300_000)

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-mail-data-'))
    process.env.MAIL_DATA_DIR = dataDir
    process.env.MAX_ATTACHMENT_BYTES = String(1024 * 1024)
    process.env.MAX_ATTACHMENTS_TOTAL_BYTES = String(1024 * 1024)
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        setupCode: SETUP_CODE,
        email: 'att@example.com',
        password: 'correct horse battery',
      },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    account = await createAccount(rows[0]!.id)

    messageId = await createMessage(
      account,
      await compose({
        text: 'Siehe Anhang',
        html: '<p>Logo: <img src="cid:logo@test"></p>',
        attachments: [
          { filename: 'Rechnung März.pdf', content: pdf, contentType: 'application/pdf' },
          { filename: 'evil.html', content: '<script>alert(1)</script>', contentType: 'text/html' },
          { filename: 'bild.png', content: PNG, contentType: 'image/png' },
          { filename: 'logo.png', content: PNG, contentType: 'image/png', cid: 'logo@test' },
        ],
      }),
    )
  })

  afterAll(async () => {
    delete process.env.MAX_ATTACHMENT_BYTES
    delete process.env.MAX_ATTACHMENTS_TOTAL_BYTES
    await app?.close()
    await pool.end()
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
  })

  it('lists the attachments of a stored raw mail', async () => {
    const res = await get(`/api/messages/${messageId}/attachments`, authToken)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json<MessageAttachmentListResponse>()
    expect(
      body.attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size })),
    ).toEqual(
      expect.arrayContaining([
        { filename: 'Rechnung März.pdf', contentType: 'application/pdf', size: pdf.length },
        { filename: 'evil.html', contentType: 'text/html', size: 25 },
        { filename: 'bild.png', contentType: 'image/png', size: PNG.length },
      ]),
    )
    expect(body.attachments.find((a) => a.filename === 'logo.png')?.inline).toBe(true)
    expect(body.attachments.find((a) => a.filename === 'bild.png')?.inline).toBe(false)
  })

  it('streams the exact bytes with download headers (RFC 5987 file name)', async () => {
    const list = (
      await get(`/api/messages/${messageId}/attachments`, authToken)
    ).json<MessageAttachmentListResponse>()
    const entry = list.attachments.find((a) => a.filename === 'Rechnung März.pdf')!
    const res = await get(
      `/api/messages/${messageId}/attachments/${entry.index}?inline=1`,
      authToken,
    )
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(pdf)).toBe(true)
    // PDF is never inline and never served with its own type.
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Rechnung M_rz.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`,
    )
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain('sandbox')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('never serves active content inline', async () => {
    const list = (
      await get(`/api/messages/${messageId}/attachments`, authToken)
    ).json<MessageAttachmentListResponse>()
    const html = list.attachments.find((a) => a.filename === 'evil.html')!
    const res = await get(
      `/api/messages/${messageId}/attachments/${html.index}?inline=1`,
      authToken,
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment;/)
    expect(res.body).toBe('<script>alert(1)</script>')

    const png = list.attachments.find((a) => a.filename === 'bild.png')!
    const image = await get(
      `/api/messages/${messageId}/attachments/${png.index}?inline=1`,
      authToken,
    )
    expect(image.headers['content-type']).toBe('image/png')
    expect(String(image.headers['content-disposition'])).toMatch(/^inline;/)
    expect(image.rawPayload.equals(PNG)).toBe(true)
  })

  it('answers 404 for unknown indexes, foreign messages and without session', async () => {
    expect((await get(`/api/messages/${messageId}/attachments/99`, authToken)).statusCode).toBe(404)
    expect((await get(`/api/messages/${messageId}/attachments/x`, authToken)).statusCode).toBe(404)
    expect((await get(`/api/messages/${randomUUID()}/attachments`, authToken)).statusCode).toBe(404)
    expect((await get(`/api/messages/${messageId}/attachments/0`)).statusCode).toBe(401)
  })

  it('stores uploads encrypted and enforces the size limits', async () => {
    const content = randomBytes(700 * 1024)
    const res = await upload(account.id, content, '../Bericht ä.bin', 'application/x-thing')
    expect(res.statusCode).toBe(201)
    const uploaded = res.json<UploadedAttachment>()
    expect(uploaded).toMatchObject({
      filename: 'Bericht ä.bin',
      contentType: 'application/x-thing',
      size: content.length,
    })

    const { rows } = await pool.query<{ filename_enc: Buffer; content_enc: Buffer }>(
      'SELECT filename_enc, content_enc FROM attachment_upload WHERE id = $1',
      [uploaded.id],
    )
    expect(rows[0]!.filename_enc.toString('utf8')).not.toContain('Bericht')
    expect(
      decryptField(
        account.dek,
        rows[0]!.filename_enc.toString('utf8'),
        uploadFieldAad('filename', uploaded.id),
      ),
    ).toBe('Bericht ä.bin')
    expect(
      decryptBytes(
        account.dek,
        rows[0]!.content_enc,
        uploadFieldAad('content', uploaded.id),
      ).equals(content),
    ).toBe(true)

    // Per file.
    const tooLarge = await upload(
      account.id,
      randomBytes(1024 * 1024 + 1),
      'big.bin',
      'application/octet-stream',
    )
    expect(tooLarge.statusCode).toBe(413)
    expect(tooLarge.json<{ message: string }>().message).toContain('zu groß')

    // Total per message: 2 x 700 KB > 1 MB.
    const second = (
      await upload(account.id, randomBytes(700 * 1024), 'b.bin', 'application/octet-stream')
    ).json<UploadedAttachment>()
    const send = (ids: string[]) =>
      app.inject({
        method: 'POST',
        url: '/api/outbox',
        headers: { cookie: `fma_session=${authToken}` },
        payload: {
          accountId: account.id,
          to: ['x@example.com'],
          subject: 'S',
          text: 'T',
          attachmentIds: ids,
        },
      })
    const total = await send([uploaded.id, second.id])
    expect(total.statusCode).toBe(413)
    const { rows: unbound } = await pool.query(
      'SELECT 1 FROM attachment_upload WHERE outbox_id IS NOT NULL',
    )
    expect(unbound).toHaveLength(0)

    // Within the limit: bound to the message; a second use fails.
    const ok = await send([uploaded.id])
    expect(ok.statusCode).toBe(201)
    const { rows: bound } = await pool.query<{ outbox_id: string }>(
      'SELECT outbox_id FROM attachment_upload WHERE id = $1',
      [uploaded.id],
    )
    expect(bound[0]!.outbox_id).toBe(ok.json<{ id: string }>().id)
    const { rows: counted } = await pool.query<{ attachment_count: number }>(
      'SELECT attachment_count FROM outbox_message WHERE id = $1',
      [ok.json<{ id: string }>().id],
    )
    expect(counted[0]!.attachment_count).toBe(1)

    // Missing uploads (already sent, expired by the cleanup, unknown): a
    // stable code with the missing ids, nothing is stored.
    const { rows: before } = await pool.query('SELECT id FROM outbox_message')
    const reused = await send([uploaded.id])
    expect(reused.statusCode).toBe(410)
    expect(reused.json<AttachmentMissingResponse>()).toMatchObject({
      code: 'ATTACHMENT_MISSING',
      missingIds: [uploaded.id],
    })
    const unknown = randomUUID()
    const missing = await send([second.id, unknown])
    expect(missing.statusCode).toBe(410)
    expect(missing.json<AttachmentMissingResponse>().missingIds).toEqual([unknown])
    const { rows: after } = await pool.query('SELECT id FROM outbox_message')
    expect(after).toHaveLength(before.length)
    const { rows: stillFree } = await pool.query<{ outbox_id: string | null }>(
      'SELECT outbox_id FROM attachment_upload WHERE id = $1',
      [second.id],
    )
    expect(stillFree[0]!.outbox_id).toBeNull()

    // Delete: only unbound uploads.
    const del = (id: string) =>
      app.inject({
        method: 'DELETE',
        url: `/api/uploads/${id}`,
        headers: { cookie: `fma_session=${authToken}` },
      })
    expect((await del(uploaded.id)).statusCode).toBe(404)
    expect((await del(second.id)).statusCode).toBe(204)
  })

  it('rejects unauthenticated uploads before reading the body, limits parallel uploads', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo
    /** Starts an upload announcing 1 MB but sending only 1 KB (body never ends). */
    const startUpload = (accountId: string, token?: string) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/api/accounts/${accountId}/uploads`,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(1024 * 1024),
          'x-filename': 'a.bin',
          ...(token ? { cookie: `fma_session=${token}` } : {}),
        },
      })
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        req.once('response', (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => (body += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        })
        req.once('error', reject)
      })
      req.write(randomBytes(1024))
      return { req, response }
    }

    // No session: 401 right away although the body is incomplete.
    const anonymous = startUpload(account.id)
    expect((await anonymous.response).status).toBe(401)
    anonymous.req.destroy()
    // Foreign or unknown account: 404 before the body, too.
    const foreign = startUpload(randomUUID(), authToken)
    expect((await foreign.response).status).toBe(404)
    foreign.req.destroy()

    process.env.MAX_CONCURRENT_UPLOADS = '1'
    try {
      const first = startUpload(account.id, authToken)
      first.response.catch(() => {}) // aborted below
      // Wait until the first upload was admitted (its body is pending).
      let second = { status: 0, body: '' }
      for (let i = 0; i < 50 && second.status !== 429; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        const attempt = startUpload(account.id, authToken)
        second = await attempt.response
        attempt.req.destroy()
      }
      expect(second.status).toBe(429)
      expect(JSON.parse(second.body).message).toContain('Uploads')
      // The aborted upload frees its slot.
      first.req.destroy()
      let res = await upload(account.id, Buffer.from('x'), 'x.txt', 'text/plain')
      for (let i = 0; i < 50 && res.statusCode === 429; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        res = await upload(account.id, Buffer.from('x'), 'x.txt', 'text/plain')
      }
      expect(res.statusCode).toBe(201)
    } finally {
      delete process.env.MAX_CONCURRENT_UPLOADS
    }
  })

  it('rejects uploads to foreign accounts', async () => {
    const res = await upload(randomUUID(), Buffer.from('x'), 'a.txt', 'text/plain')
    expect(res.statusCode).toBe(404)
  })

  function json(method: 'PUT' | 'POST' | 'GET' | 'DELETE', url: string, payload?: object) {
    return app.inject({
      method,
      url,
      payload: payload as Record<string, unknown> | undefined,
      headers: { cookie: `fma_session=${authToken}` },
    })
  }

  const draftBody = (extra: Record<string, unknown> = {}) => ({
    accountId: account.id,
    to: 'anna@example.com',
    cc: '',
    bcc: '',
    subject: 'Entwurf mit Anhang',
    text: 'Text',
    ...extra,
  })

  it('keeps uploads with a draft until it is discarded', async () => {
    const a = (
      await upload(account.id, Buffer.from('eins'), 'eins.txt', 'text/plain')
    ).json<UploadedAttachment>()
    const b = (
      await upload(account.id, Buffer.from('zwei'), 'zwei.txt', 'text/plain')
    ).json<UploadedAttachment>()
    const draftId = randomUUID()
    let res = await json(
      'PUT',
      `/api/drafts/${draftId}`,
      draftBody({ attachmentIds: [a.id, b.id, randomUUID()] }),
    )
    expect(res.statusCode).toBe(201)
    expect(res.json<Draft>().attachments.map((x) => x.filename)).toEqual(['eins.txt', 'zwei.txt'])

    // A save without attachmentIds (older client, offline replay) keeps them.
    res = await json('PUT', `/api/drafts/${draftId}`, draftBody({ baseVersion: 1, text: 'Neu' }))
    expect(res.json<Draft>().attachments).toHaveLength(2)
    // Reopening shows them.
    res = await json('GET', `/api/drafts/${draftId}`)
    expect(res.json<Draft>().attachments.map((x) => x.id)).toEqual([a.id, b.id])

    // Removing one releases it from the draft.
    res = await json(
      'PUT',
      `/api/drafts/${draftId}`,
      draftBody({ baseVersion: 2, attachmentIds: [a.id] }),
    )
    expect(res.json<Draft>().attachments.map((x) => x.id)).toEqual([a.id])
    const { rows: released } = await pool.query(
      'SELECT draft_id FROM attachment_upload WHERE id = $1',
      [b.id],
    )
    expect(released[0]!.draft_id).toBeNull()

    // Discarding the draft deletes its uploads.
    expect((await json('DELETE', `/api/drafts/${draftId}`)).statusCode).toBe(204)
    const { rows } = await pool.query('SELECT 1 FROM attachment_upload WHERE id = $1', [a.id])
    expect(rows).toHaveLength(0)
  })

  it('moves the uploads of a draft to the message when it is sent', async () => {
    const a = (
      await upload(account.id, Buffer.from('anhang'), 'a.txt', 'text/plain')
    ).json<UploadedAttachment>()
    const draftId = randomUUID()
    await json('PUT', `/api/drafts/${draftId}`, draftBody({ attachmentIds: [a.id] }))
    const res = await json('POST', '/api/outbox', {
      accountId: account.id,
      to: ['anna@example.com'],
      subject: 'Entwurf mit Anhang',
      text: 'Text',
      draftId,
      attachmentIds: [a.id],
    })
    expect(res.statusCode).toBe(201)
    const { rows } = await pool.query<{ outbox_id: string | null; draft_id: string | null }>(
      'SELECT outbox_id, draft_id FROM attachment_upload WHERE id = $1',
      [a.id],
    )
    expect(rows[0]).toEqual({ outbox_id: res.json<{ id: string }>().id, draft_id: null })
    // The draft row going away (draft_sync) does not take the upload with it.
    await pool.query('DELETE FROM draft WHERE id = $1', [draftId])
    const { rows: still } = await pool.query('SELECT 1 FROM attachment_upload WHERE id = $1', [
      a.id,
    ])
    expect(still).toHaveLength(1)
  })

  it('copies the attachments of a message for forwarding, encrypted', async () => {
    const res = await json('POST', `/api/messages/${messageId}/attachments/copy`, {
      accountId: account.id,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<CopyAttachmentsResponse>()
    // The inline logo of the HTML body is not taken over.
    expect(body.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['Rechnung März.pdf', 'application/pdf'],
      ['evil.html', 'text/html'],
      ['bild.png', 'image/png'],
    ])
    expect(body.skipped).toBe(0)
    const { rows } = await pool.query<{
      filename_enc: Buffer
      content_enc: Buffer
      draft_id: string | null
    }>('SELECT filename_enc, content_enc, draft_id FROM attachment_upload WHERE id = $1', [
      body.attachments[0]!.id,
    ])
    expect(rows[0]!.filename_enc.toString('utf8')).not.toContain('Rechnung')
    expect(rows[0]!.draft_id).toBeNull()
    expect(
      decryptBytes(
        account.dek,
        rows[0]!.content_enc,
        uploadFieldAad('content', body.attachments[0]!.id),
      ).equals(pdf),
    ).toBe(true)
    expect(
      decryptField(
        account.dek,
        rows[0]!.filename_enc.toString('utf8'),
        uploadFieldAad('filename', body.attachments[0]!.id),
      ),
    ).toBe('Rechnung März.pdf')
    await pool.query('DELETE FROM attachment_upload WHERE id = ANY($1::uuid[])', [
      body.attachments.map((a) => a.id),
    ])
  })

  it('skips attachments beyond the limits when copying', async () => {
    process.env.MAX_ATTACHMENT_BYTES = String(100_000)
    try {
      const res = await json('POST', `/api/messages/${messageId}/attachments/copy`, {
        accountId: account.id,
      })
      const body = res.json<CopyAttachmentsResponse>()
      expect(body.attachments.map((a) => a.filename)).toEqual(['evil.html', 'bild.png'])
      expect(body.skipped).toBe(1)
      await pool.query('DELETE FROM attachment_upload WHERE id = ANY($1::uuid[])', [
        body.attachments.map((a) => a.id),
      ])
    } finally {
      process.env.MAX_ATTACHMENT_BYTES = String(1024 * 1024)
    }
  })

  it('keeps the attachments of a draft written in another client when it is opened', async () => {
    const res = await json('POST', `/api/messages/${messageId}/draft`)
    expect(res.statusCode).toBe(201)
    const draft = res.json<Draft>()
    expect(draft.attachments.map((a) => a.filename)).toEqual([
      'Rechnung März.pdf',
      'evil.html',
      'bild.png',
    ])
    const { rows } = await pool.query('SELECT 1 FROM attachment_upload WHERE draft_id = $1', [
      draft.id,
    ])
    expect(rows).toHaveLength(3)
    await json('DELETE', `/api/drafts/${draft.id}`)
  })

  async function keepSource(draftId: string): Promise<boolean> {
    const { rows } = await pool.query<{ keep_source: boolean }>(
      'SELECT keep_source FROM draft WHERE id = $1',
      [draftId],
    )
    return rows[0]!.keep_source
  }

  it('keeps the original draft when not all of its attachments could be copied', async () => {
    // Fully copied: the original may be replaced on the first upload.
    let res = await json('POST', `/api/messages/${messageId}/draft`)
    let draft = res.json<Draft>()
    expect(draft.attachmentsSkipped).toBeUndefined()
    expect(await keepSource(draft.id)).toBe(false)
    await json('DELETE', `/api/drafts/${draft.id}`)

    // One attachment over the size limit: skipped, the original stays.
    process.env.MAX_ATTACHMENT_BYTES = String(100_000)
    try {
      res = await json('POST', `/api/messages/${messageId}/draft`)
    } finally {
      process.env.MAX_ATTACHMENT_BYTES = String(1024 * 1024)
    }
    expect(res.statusCode).toBe(201)
    draft = res.json<Draft>()
    expect(draft.attachments.map((a) => a.filename)).toEqual(['evil.html', 'bild.png'])
    expect(draft.attachmentsSkipped).toBe(1)
    expect(await keepSource(draft.id)).toBe(true)
    // Reopening resumes the draft (no second copy).
    res = await json('POST', `/api/messages/${messageId}/draft`)
    expect(res.statusCode).toBe(200)
    expect(res.json<Draft>().id).toBe(draft.id)
    await json('DELETE', `/api/drafts/${draft.id}`)

    // Raw mail not stored, but the message has attachments: the original stays.
    const noRaw = await createMessage(account, null)
    await pool.query('UPDATE message SET has_attachments = true WHERE id = $1', [noRaw])
    await pool.query(
      `INSERT INTO message_body (message_id, storage_ref, text_plain_enc) VALUES ($1, NULL, $2)`,
      [noRaw, Buffer.from(encryptField(account.dek, 'x', messageFieldAad('text', noRaw)), 'utf8')],
    )
    res = await json('POST', `/api/messages/${noRaw}/draft`)
    expect(res.statusCode).toBe(201)
    draft = res.json<Draft>()
    expect(draft.attachmentsSkipped).toBe(1)
    expect(await keepSource(draft.id)).toBe(true)
    await json('DELETE', `/api/drafts/${draft.id}`)
  })

  it('shares the admission of uploads with attachment copies (weight 2)', async () => {
    // Multipart, like the message sync flags it.
    await pool.query('UPDATE message SET has_attachments = true WHERE id = $1', [messageId])
    // One upload in progress: a copy (weight 2) does not fit in the default 2.
    const release = tryAdmitUpload()
    expect(release).not.toBeNull()
    try {
      const copy = await json('POST', `/api/messages/${messageId}/attachments/copy`, {
        accountId: account.id,
      })
      expect(copy.statusCode).toBe(429)
      // Opening a foreign draft does not copy then and keeps the original.
      const res = await json('POST', `/api/messages/${messageId}/draft`)
      expect(res.statusCode).toBe(201)
      const draft = res.json<Draft>()
      expect(draft.attachments).toEqual([])
      expect(draft.attachmentsSkipped).toBeGreaterThan(0)
      expect(await keepSource(draft.id)).toBe(true)
      await json('DELETE', `/api/drafts/${draft.id}`)
    } finally {
      release!()
    }
    // A copy alone fits, and blocks a further upload while it runs.
    const copying = tryAdmitUpload(COPY_ADMISSION_WEIGHT)
    expect(copying).not.toBeNull()
    expect(tryAdmitUpload()).toBeNull()
    copying!()
    const again = tryAdmitUpload()
    expect(again).not.toBeNull()
    again!()
  })

  it('limits pending and draft uploads separately and atomically per account', async () => {
    const { rows: users } = await pool.query<{ id: string }>(
      `SELECT id FROM "user" WHERE email = 'att@example.com'`,
    )
    const limited = await createAccount(users[0]!.id)
    const fill = async (count: number, draftId: string | null) =>
      pool.query(
        `INSERT INTO attachment_upload
           (id, account_id, filename_enc, content_type, size_bytes, content_enc, draft_id)
         SELECT gen_random_uuid(), $1::uuid, '\\x00', 'text/plain', 1, '\\x00', $2::uuid
         FROM generate_series(1, $3::int)`,
        [limited.id, draftId, count],
      )
    const draftId = randomUUID()
    await json('PUT', `/api/drafts/${draftId}`, draftBody({ accountId: limited.id }))

    // Uploads kept with drafts do not count against the pending limit.
    await fill(MAX_PENDING_UPLOADS, draftId)
    await fill(MAX_PENDING_UPLOADS - 1, null)
    // Count + insert is serialized: of parallel uploads only one fits.
    process.env.MAX_CONCURRENT_UPLOADS = '10'
    let parallel: Awaited<ReturnType<typeof upload>>[]
    try {
      parallel = await Promise.all(
        Array.from({ length: 6 }, () =>
          upload(limited.id, Buffer.from('x'), 'x.txt', 'text/plain'),
        ),
      )
    } finally {
      delete process.env.MAX_CONCURRENT_UPLOADS
    }
    expect(parallel.filter((r) => r.statusCode === 429)).toHaveLength(5)
    const created = parallel.filter((r) => r.statusCode === 201)
    expect(created).toHaveLength(1)
    const { rows: pending } = await pool.query<{ count: string }>(
      `SELECT count(*) FROM attachment_upload
       WHERE account_id = $1 AND draft_id IS NULL AND outbox_id IS NULL`,
      [limited.id],
    )
    expect(Number(pending[0]!.count)).toBe(MAX_PENDING_UPLOADS)

    // Uploads kept with drafts have their own limit.
    await fill(MAX_DRAFT_UPLOADS - MAX_PENDING_UPLOADS, draftId)
    const other = randomUUID()
    const res = await json(
      'PUT',
      `/api/drafts/${other}`,
      draftBody({
        accountId: limited.id,
        attachmentIds: [created[0]!.json<UploadedAttachment>().id],
      }),
    )
    expect(res.statusCode).toBe(429)
    const { rows: kept } = await pool.query('SELECT 1 FROM draft WHERE id = $1', [other])
    expect(kept).toHaveLength(0)
    await pool.query('DELETE FROM mail_account WHERE id = $1', [limited.id])
  })

  it('copies only from own messages to own accounts', async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('copy-other@example.com', 'x') RETURNING id`,
    )
    const foreign = await createAccount(other.rows[0]!.id)
    const foreignMessage = await createMessage(
      foreign,
      await compose({ text: 'x', attachments: [{ filename: 'a.txt', content: 'a' }] }),
    )
    const cases = [
      [`/api/messages/${foreignMessage}/attachments/copy`, account.id],
      [`/api/messages/${messageId}/attachments/copy`, foreign.id],
      [`/api/messages/${randomUUID()}/attachments/copy`, account.id],
      [`/api/messages/${messageId}/attachments/copy`, 'nope'],
    ] as const
    for (const [url, accountId] of cases) {
      expect((await json('POST', url, { accountId })).statusCode).toBe(404)
    }
    const anonymous = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/attachments/copy`,
      payload: { accountId: account.id },
    })
    expect(anonymous.statusCode).toBe(401)
    // Raw mail not stored yet.
    const pending = await createMessage(account, null)
    expect(
      (await json('POST', `/api/messages/${pending}/attachments/copy`, { accountId: account.id }))
        .statusCode,
    ).toBe(409)
    const { rows } = await pool.query('SELECT 1 FROM attachment_upload WHERE account_id = $1', [
      foreign.id,
    ])
    expect(rows).toHaveLength(0)
  })
})
