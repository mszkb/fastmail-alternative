/**
 * Integration tests for GET /api/messages/:id/html (roadmap 2.9): the HTML
 * part is read from the encrypted raw mail in MAIL_DATA_DIR (written exactly
 * like the worker's message sync does), sanitized, remote content blocked
 * unless remote=1, inline cid: images embedded; ownership checks and
 * no-store caching. Requires DATABASE_URL; skipped when unset.
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
  encryptBytes,
  encryptField,
  generateDataKey,
  loadMasterKey,
  messageFieldAad,
  wrapDataKey,
} from '@fma/crypto'
import type { MessageHtmlResponse } from '@fma/shared'
import { buildApp } from '../src/app'
import { pool } from '../src/db'

/** Setup code configured for the tests (vitest.config.ts). */
const SETUP_CODE = 'test-setup-code'

process.env.MASTER_KEY ??= randomBytes(32).toString('base64')

const databaseUrl = process.env.DATABASE_URL
const TABLES =
  'session, device, "user", mail_account, identity, folder, job, message, message_location, message_body'
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
      enc('subject', 'Newsletter'),
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

const HOSTILE_HTML = `<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<base href="https://evil.example/">
<style>.hero { background: url(https://cdn.example/hero.png) } @import url(https://evil.example/x.css);</style>
<script>window.pwned = 1</script>
</head><body onload="window.pwned = 1">
<p>Hallo <b>Welt</b> – Grüße</p>
<img src="https://track.example/open.gif?u=42" width="1" height="1">
<img src="cid:logo@shop" alt="Logo">
<a href="javascript:window.pwned=1">klick</a>
<a href="https://shop.example/angebot">Angebot</a>
<form action="https://evil.example/login"><input name="password"></form>
<iframe src="https://evil.example/"></iframe>
</body></html>`

describe.skipIf(!databaseUrl)('message html api', () => {
  let account: { id: string; dek: Buffer }
  let hostileId: string
  let legacyId: string
  let largeAttachmentId: string
  let textOnlyId: string
  let notSyncedId: string
  let missingFileId: string
  let foreignId: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'fma-mail-data-'))
    process.env.MAIL_DATA_DIR = dataDir
    app = buildApp({ logger: false })
    await runMigrations(pool)
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        setupCode: SETUP_CODE,
        email: 'html@example.com',
        password: 'correct horse battery',
      },
    })
    authToken = setup.cookies.find((c) => c.name === 'fma_session')!.value
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user"')
    account = await createAccount(rows[0]!.id)

    hostileId = await createMessage(
      account,
      await compose({
        text: 'Hallo Welt',
        html: HOSTILE_HTML,
        attachments: [{ filename: 'logo.png', content: PNG, cid: 'logo@shop' }],
      }),
    )
    legacyId = await createMessage(
      account,
      await compose({ html: '<p>Alte Datei – Grüße</p>' }),
      true,
    )
    largeAttachmentId = await createMessage(
      account,
      await compose({
        html: '<p>Mit Anhang</p><img src="cid:big@shop"><img src="cid:logo@shop">',
        attachments: [
          { filename: 'report.pdf', content: randomBytes(3 * 1024 * 1024) },
          // Over the data: URL limit: dropped, not buffered.
          {
            filename: 'big.png',
            content: randomBytes(6 * 1024 * 1024),
            contentType: 'image/png',
            cid: 'big@shop',
          },
          { filename: 'logo.png', content: PNG, cid: 'logo@shop' },
        ],
      }),
    )
    textOnlyId = await createMessage(account, await compose({ text: 'Nur Text' }))
    notSyncedId = await createMessage(account, null)
    missingFileId = await createMessage(account, await compose({ html: '<p>x</p>' }))
    await rm(path.join(dataDir, account.id, missingFileId), { recursive: true })

    const other = await pool.query<{ id: string }>(
      `INSERT INTO "user" (email, password_hash) VALUES ('other@example.com', 'x') RETURNING id`,
    )
    const foreign = await createAccount(other.rows[0]!.id)
    foreignId = await createMessage(foreign, await compose({ html: '<p>Foreign secret</p>' }))
  })

  afterAll(async () => {
    await pool.query(`TRUNCATE ${TABLES} CASCADE`)
    await pool.end()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('requires authentication', async () => {
    expect((await get(`/api/messages/${hostileId}/html`)).statusCode).toBe(401)
  })

  it('returns 404 for foreign, unknown and malformed ids', async () => {
    for (const id of [foreignId, randomUUID(), 'not-a-uuid']) {
      const res = await get(`/api/messages/${id}/html`, authToken)
      expect(res.statusCode).toBe(404)
      expect(res.body).not.toContain('Foreign secret')
    }
  })

  it('returns sanitized html with remote content blocked by default', async () => {
    const res = await get(`/api/messages/${hostileId}/html`, authToken)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json<MessageHtmlResponse>()
    expect(body.remoteContentBlocked).toBe(true)
    const html = body.html!
    expect(html).toContain('<p>Hallo <b>Welt</b> – Grüße</p>')
    expect(html).toContain(
      '<a href="https://shop.example/angebot" target="_blank" rel="noopener noreferrer nofollow">Angebot</a>',
    )
    // Inline image embedded as data URL, remote ones removed.
    expect(html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`)
    expect(html).not.toMatch(/https?:\/\/(cdn|track|evil)\.example/)
    expect(html).not.toMatch(/<(script|meta|base|form|input|iframe)\b/i)
    expect(html).not.toMatch(/javascript:|onload|pwned/i)
  })

  it('reads raw mails stored in the legacy text format', async () => {
    const res = await get(`/api/messages/${legacyId}/html`, authToken)
    expect(res.json<MessageHtmlResponse>().html).toContain('<p>Alte Datei – Grüße</p>')
  })

  it('embeds small inline images and drops large attachments', async () => {
    const res = await get(`/api/messages/${largeAttachmentId}/html`, authToken)
    const html = res.json<MessageHtmlResponse>().html!
    expect(html).toContain('<p>Mit Anhang</p>')
    expect(html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`)
    expect(html.length).toBeLessThan(10_000)
  })

  it('keeps http(s) images with remote=1', async () => {
    const res = await get(`/api/messages/${hostileId}/html?remote=1`, authToken)
    const body = res.json<MessageHtmlResponse>()
    expect(body.remoteContentBlocked).toBe(false)
    expect(body.html).toContain('src="https://track.example/open.gif?u=42"')
    expect(body.html).toContain('url("https://cdn.example/hero.png")')
    // Still no style sheets, frames or scripts.
    expect(body.html).not.toMatch(/evil\.example|pwned|<script/i)
  })

  it('returns html null for text-only, unsynced and unreadable bodies', async () => {
    for (const id of [textOnlyId, notSyncedId, missingFileId]) {
      const res = await get(`/api/messages/${id}/html`, authToken)
      expect(res.statusCode).toBe(200)
      expect(res.json<MessageHtmlResponse>()).toEqual({ html: null, remoteContentBlocked: false })
    }
  })

  it('never reads outside the mail-data volume', async () => {
    await pool.query('UPDATE message_body SET storage_ref = $1 WHERE message_id = $2', [
      '../../etc/passwd',
      textOnlyId,
    ])
    const res = await get(`/api/messages/${textOnlyId}/html`, authToken)
    expect(res.json<MessageHtmlResponse>().html).toBeNull()
  })
})
