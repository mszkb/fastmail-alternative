/**
 * Integration tests for attachments (roadmap 5.3): listing and streaming
 * received attachments out of the encrypted raw mail (bytes, safe headers,
 * no inline delivery of active content), uploads for sending (encrypted at
 * rest, size limit, ownership) and binding them in POST /api/outbox.
 * Requires DATABASE_URL; skipped when unset.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import type { MessageAttachmentListResponse, UploadedAttachment } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body, outbox_message, attachment_upload'
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
      payload: { email: 'att@example.com', password: 'correct horse battery' },
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
    expect((await send([uploaded.id])).statusCode).toBe(400)
    expect((await send([randomUUID()])).statusCode).toBe(400)

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

  it('rejects uploads to foreign accounts', async () => {
    const res = await upload(randomUUID(), Buffer.from('x'), 'a.txt', 'text/plain')
    expect(res.statusCode).toBe(404)
  })
})
